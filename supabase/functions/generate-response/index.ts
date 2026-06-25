// Edge Function: generate-response
// Orquesta una sesión CMA para responder a un mensaje inbound clasificado.
//
//  - Toma el mensaje (POST {message_id} o el más viejo sin draft)
//  - Abre sesión con master (read_only) y leads (read_write) Memory Stores
//  - Inyecta contexto del lead + clasificación
//  - Stream events; resuelve custom_tool_use de `search_kb` con embed + RPC
//  - Capturas agent.message, guarda como draft

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@0.95.1";
import { loadConfig, type ConfigReader } from "../_shared/config.ts";
import { recordUsage, captureSessionUsage } from "../_shared/usage.ts";
import {
  patchLeadField,
  patchContactField,
  moveLeadStage,
  fetchPipelineStages,
  fetchEntityFields,
  addLeadNote,
  setLeadCheckboxField,
  addLeadTags,
  patchEntityFieldEnum,
  patchContactCodeField,
  fetchKnownLeadData,
  type KommoStageLite,
  type KommoFieldLite,
  type KnownLeadData,
} from "../_shared/kommo.ts";
import {
  searchProducts,
  listCollections,
  findOrders,
  createCheckoutLink,
  resolveShopifyCreds,
  type ShopifyCreds,
  type ShopifyProduct,
  type ShopifyOrder,
} from "../_shared/shopify.ts";
import { getBcvRate } from "../_shared/exchange.ts";
import {
  isBusinessHours,
  businessHoursLabel,
  type BusinessHoursConfig,
} from "../_shared/business-hours.ts";

// SUPABASE_URL and SERVICE_ROLE are injected by the Supabase runtime and
// always come from env — they are infrastructure constants, not per-client
// configuration, and are required before we can even read runtime_config.
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

// ---------------- search_kb tool implementation ----------------
async function runSearchKb(input: { query: string; limit?: number }) {
  // 1) Embeber el query
  const embedRes = await fetch(`${SUPABASE_URL}/functions/v1/embed`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${SERVICE_ROLE}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ inputs: [input.query] }),
  });
  if (!embedRes.ok) {
    throw new Error(`embed: ${embedRes.status} ${await embedRes.text()}`);
  }
  const { embeddings } = (await embedRes.json()) as { embeddings: number[][] };

  // 2) Llamar a RPC search_kb
  const { data, error } = await supabase.rpc("search_kb", {
    p_query_embedding: embeddings[0],
    p_query_text: input.query,
    p_limit: Math.min(input.limit ?? 5, 12),
    p_min_similarity: 0.15,
  });
  if (error) throw new Error(`search_kb: ${error.message}`);

  const rows = (data ?? []) as Array<{
    chunk_id: string;
    document_id: string;
    document_title: string;
    content: string;
    similarity: number;
    fts_rank: number;
  }>;

  if (rows.length === 0) {
    return "Sin resultados en la KB para ese query. Asumí que la info no está documentada.";
  }

  return rows
    .map(
      (r, i) =>
        `### Resultado ${i + 1} — [${r.document_title}] (similitud ${r.similarity.toFixed(2)})\n${r.content.trim()}`
    )
    .join("\n\n---\n\n");
}

// ---------------- HTTP Tools (DB-driven, 60s TTL cache) ----------------
// Mirrors the configCache / verticalsCache pattern. Loaded BEFORE the
// EdgeRuntime.waitUntil boundary so new tools (pure DB data) work without
// any edge-function redeploy — only generate-response itself needs to be
// redeployed once when this executor code is first shipped.

type HttpToolRow = {
  name: string;
  description: string;
  http_method: string;
  url_template: string;
  headers: Array<{ name: string; value: string }>;
  body_template: unknown | null;
  input_schema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
  timeout_ms: number;
};

let toolsCache: { items: HttpToolRow[]; loadedAt: number } | null = null;
const TOOLS_TTL_MS = 60_000;

// deno-lint-ignore no-explicit-any
async function loadHttpTools(supabaseClient: any): Promise<HttpToolRow[]> {
  if (toolsCache && Date.now() - toolsCache.loadedAt < TOOLS_TTL_MS) {
    return toolsCache.items;
  }
  const { data, error } = await supabaseClient
    .from("agent_tools")
    .select("name, description, http_method, url_template, headers, body_template, input_schema, timeout_ms")
    .eq("tool_type", "http")
    .eq("enabled", true);
  if (error) {
    console.warn("generate-response: loadHttpTools error:", error.message);
    return [];
  }
  const items = (data ?? []) as HttpToolRow[];
  toolsCache = { items, loadedAt: Date.now() };
  return items;
}

/**
 * Recursively substitutes {{param}} placeholders in a body_template value.
 * - String leaf that is EXACTLY "{{param}}" → replaced with the typed input
 *   value (preserves numbers/booleans).
 * - String leaf with embedded "{{param}}" → string interpolation.
 */
function substituteBodyTemplate(
  template: unknown,
  input: Record<string, unknown>
): unknown {
  if (typeof template === "string") {
    const exactMatch = template.match(/^\{\{(\w+)\}\}$/);
    if (exactMatch) {
      const key = exactMatch[1];
      return key in input ? input[key] : null;
    }
    return template.replace(/\{\{(\w+)\}\}/g, (_, k) =>
      k in input ? String(input[k]) : ""
    );
  }
  if (Array.isArray(template)) {
    return template.map((item) => substituteBodyTemplate(item, input));
  }
  if (template !== null && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      out[k] = substituteBodyTemplate(v, input);
    }
    return out;
  }
  return template;
}

/**
 * Generic HTTP tool executor. Never throws — wraps all failures in an
 * ERROR_* string so the CMA session is never crashed by a bad tool call.
 */
async function runHttpTool(
  tool: HttpToolRow,
  input: Record<string, unknown>,
  cfg: ConfigReader
): Promise<string> {
  try {
    // (a) Validate required input fields.
    for (const k of tool.input_schema.required ?? []) {
      if (!(k in input)) {
        return `ERROR_VALIDACION: falta el parámetro requerido "${k}". Esquema requeridos: ${JSON.stringify(tool.input_schema.required)}`;
      }
    }

    // (b) Substitute {{param}} in url_template (URL-encode each value).
    const url = tool.url_template.replace(/\{\{(\w+)\}\}/g, (_, p) =>
      encodeURIComponent(String(input[p] ?? ""))
    );

    // (c) Resolve {{CONFIG_KEY}} in header values via cfg.get (not from input).
    const headers: Record<string, string> = {};
    for (const h of tool.headers ?? []) {
      headers[h.name] = h.value.replace(/\{\{(\w+)\}\}/g, (_, k) =>
        cfg.get(k) ?? ""
      );
    }

    // (d) Build body for non-GET via recursive template walk.
    let body: string | undefined;
    const method = tool.http_method.toUpperCase();
    if (method !== "GET" && tool.body_template != null) {
      const substituted = substituteBodyTemplate(tool.body_template, input);
      body = JSON.stringify(substituted);
      headers["content-type"] ??= "application/json";
    }

    // (e) HTTPS-only assert.
    if (!url.startsWith("https://")) {
      return "ERROR: url_template debe ser https://";
    }

    // (f) AbortController with tool timeout.
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), tool.timeout_ms);

    try {
      const res = await fetch(url, { method, headers, body, signal: ctrl.signal });
      const text = await res.text();
      // (g) Cap response at 8 KB.
      const capped =
        text.length > 8192 ? text.slice(0, 8192) + "…[truncado]" : text;
      return res.ok ? capped : `ERROR_HTTP ${res.status}: ${capped}`;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return `ERROR_EJECUCION: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ---------------- CRM Tools (internas, gate por config) ----------------
// MÓDULO 3 — el agente OPERA Kommo POR NOMBRE: mover de etapa, completar campos
// del lead/contacto. Las tools están SIEMPRE declaradas (el agente sabe que
// existen) pero solo se EJECUTAN si el operador activó la capacidad (gate
// runtime en kommo_publish_config). Resolución nombre→id con caché de 60s para
// no pegarle a Kommo en cada llamada.

type CrmGate = {
  enabled: boolean; // master switch
  moveStage: boolean;
  updateLead: boolean;
  updateContact: boolean;
  addNote: boolean;
  handoff: boolean;
  tag: boolean;
};

type CrmContext = {
  kommoLeadId: number | null;
  kommoContactId: number | null;
  domain: string;
  token: string;
  gate: CrmGate;
  agentOffFieldId?: number | null; // campo "Apagar Agente" de Kommo (para handoff)
  // Campos para registrar lead_stage_events (opcionales; fail-open si ausentes)
  internalLeadId?: string;
  currentKommoStageId?: number | null;
  draftId?: string;
};

const CRM_TOOL_NAMES = new Set([
  "mover_etapa",
  "actualizar_lead",
  "actualizar_contacto",
  "agregar_nota",
  "transferir_asesor",
  "etiquetar_lead",
]);
const CRM_TTL_MS = 60_000;
let stagesCache: { items: KommoStageLite[]; loadedAt: number } | null = null;
let leadFieldsCache: { items: KommoFieldLite[]; loadedAt: number } | null = null;
let contactFieldsCache: { items: KommoFieldLite[]; loadedAt: number } | null = null;

function norm(s: string): string {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
}

async function getStages(domain: string, token: string): Promise<KommoStageLite[]> {
  if (stagesCache && Date.now() - stagesCache.loadedAt < CRM_TTL_MS) return stagesCache.items;
  const items = await fetchPipelineStages(domain, token);
  stagesCache = { items, loadedAt: Date.now() };
  return items;
}

async function getEntityFields(
  entity: "leads" | "contacts",
  domain: string,
  token: string
): Promise<KommoFieldLite[]> {
  const cache = entity === "leads" ? leadFieldsCache : contactFieldsCache;
  if (cache && Date.now() - cache.loadedAt < CRM_TTL_MS) return cache.items;
  const items = await fetchEntityFields(entity, domain, token);
  const entry = { items, loadedAt: Date.now() };
  if (entity === "leads") leadFieldsCache = entry;
  else contactFieldsCache = entry;
  return items;
}

// Ejecuta una tool CRM por nombre. Devuelve un string para el agente (el caller
// envuelve en try/catch y manda el resultado como custom_tool_result).
async function runCrmTool(
  name: string,
  input: Record<string, unknown>,
  ctx: CrmContext
): Promise<string> {
  if (!ctx.gate.enabled) {
    return "Las acciones en el CRM están DESACTIVADAS por el operador. No realices esta acción ni se la menciones al lead.";
  }

  if (name === "mover_etapa") {
    if (!ctx.gate.moveStage) return "La acción 'mover de etapa' está desactivada por el operador. No la realices.";
    if (ctx.kommoLeadId == null) return "No tengo el id de Kommo de este lead; no puedo mover la etapa.";
    const stageName = String(input.stage_name ?? "").trim();
    if (!stageName) return "ERROR_VALIDACION: falta 'stage_name'.";
    const pipelineName = String(input.pipeline_name ?? "").trim();
    const stages = await getStages(ctx.domain, ctx.token);
    let matches = stages.filter((s) => norm(s.name) === norm(stageName));
    if (pipelineName) matches = matches.filter((s) => norm(s.pipelineName) === norm(pipelineName));
    if (matches.length === 0) {
      const opciones = stages.map((s) => `"${s.name}" (pipeline "${s.pipelineName}")`).join(", ");
      return `No encontré una etapa llamada "${stageName}". Etapas disponibles: ${opciones || "(ninguna)"}.`;
    }
    if (matches.length > 1) {
      const opciones = matches.map((s) => `pipeline "${s.pipelineName}"`).join(", ");
      return `La etapa "${stageName}" existe en varios pipelines (${opciones}). Especificá 'pipeline_name' y reintentá.`;
    }
    const target = matches[0];
    await moveLeadStage(ctx.kommoLeadId, target.id, target.pipelineId, ctx.domain, ctx.token);

    // Registrar evento de cambio de etapa (fail-open: nunca romper el tool).
    if (ctx.internalLeadId) {
      try {
        // Resolver nombre de etapa anterior si tenemos el id previo
        let fromStageName: string | null = null;
        const prevStageId = ctx.currentKommoStageId;
        if (prevStageId != null) {
          const prevStage = stages.find((s) => s.id === prevStageId);
          fromStageName = prevStage?.name ?? null;
        }
        await supabase.from("lead_stage_events").insert({
          lead_id: ctx.internalLeadId,
          from_stage_id: prevStageId ?? null,
          to_stage_id: target.id,
          from_stage_name: fromStageName,
          to_stage_name: target.name,
          pipeline_name: target.pipelineName,
          moved_by: "agente",
          draft_id: ctx.draftId ?? null,
        });
        // Actualizar kommo_stage_id en leads para mantener el estado en sync
        await supabase
          .from("leads")
          .update({ kommo_stage_id: target.id })
          .eq("id", ctx.internalLeadId);
      } catch (evErr) {
        console.warn("lead_stage_events insert (agente) — fail-open:", evErr instanceof Error ? evErr.message : String(evErr));
      }
    }

    return `Listo: moví el lead a la etapa "${target.name}" (pipeline "${target.pipelineName}").`;
  }

  if (name === "actualizar_lead") {
    if (!ctx.gate.updateLead) return "La acción 'actualizar datos del lead' está desactivada por el operador. No la realices.";
    if (ctx.kommoLeadId == null) return "No tengo el id de Kommo de este lead; no puedo actualizar el campo.";
    const fieldName = String(input.field_name ?? "").trim();
    const value = input.value == null ? "" : String(input.value);
    if (!fieldName) return "ERROR_VALIDACION: falta 'field_name'.";
    const fields = await getEntityFields("leads", ctx.domain, ctx.token);
    const f = fields.find((x) => norm(x.name) === norm(fieldName));
    if (!f) {
      const opciones = fields.map((x) => `"${x.name}"`).join(", ");
      return `No existe un campo de lead llamado "${fieldName}". Campos disponibles: ${opciones || "(ninguno)"}.`;
    }
    // Campos tipo lista (select/multiselect): resolver el valor textual → enum_id.
    if (f.type === "select" || f.type === "multiselect") {
      const wanted = value.split(/[,;]+/).map((v) => v.trim()).filter(Boolean);
      const matched = f.enums.filter((e) => wanted.some((w) => norm(w) === norm(e.value)));
      if (matched.length === 0) {
        const validos = f.enums.map((e) => `"${e.value}"`).join(", ");
        return `El campo "${f.name}" es una lista; valores válidos: ${validos || "(ninguno)"}. Reintentá con uno de esos.`;
      }
      const enumIds = f.type === "select" ? [matched[0].id] : matched.map((e) => e.id);
      await patchEntityFieldEnum("leads", ctx.kommoLeadId, f.id, enumIds, ctx.domain, ctx.token);
      return `Listo: actualicé "${f.name}" del lead a ${matched.map((e) => `"${e.value}"`).join(", ")}.`;
    }
    await patchLeadField(ctx.kommoLeadId, f.id, value, ctx.domain, ctx.token);
    return `Listo: actualicé el campo "${f.name}" del lead a "${value}".`;
  }

  if (name === "actualizar_contacto") {
    if (!ctx.gate.updateContact) return "La acción 'actualizar datos del contacto' está desactivada por el operador. No la realices.";
    if (ctx.kommoContactId == null) return "Este lead no tiene un contacto asociado en Kommo; no puedo actualizar el campo.";
    const fieldName = String(input.field_name ?? "").trim();
    const value = input.value == null ? "" : String(input.value);
    if (!fieldName) return "ERROR_VALIDACION: falta 'field_name'.";
    const fields = await getEntityFields("contacts", ctx.domain, ctx.token);
    const f = fields.find((x) => norm(x.name) === norm(fieldName));
    if (!f) {
      const opciones = fields.map((x) => `"${x.name}"`).join(", ");
      return `No existe un campo de contacto llamado "${fieldName}". Campos disponibles: ${opciones || "(ninguno)"}.`;
    }
    // Teléfono/email del contacto: campos de sistema con shape distinto (field_code + enum_code).
    if (f.code === "PHONE" || f.code === "EMAIL") {
      await patchContactCodeField(ctx.kommoContactId, f.code, value, "WORK", ctx.domain, ctx.token);
      return `Listo: actualicé el ${f.code === "PHONE" ? "teléfono" : "email"} del contacto a "${value}".`;
    }
    if (f.type === "select" || f.type === "multiselect") {
      const wanted = value.split(/[,;]+/).map((v) => v.trim()).filter(Boolean);
      const matched = f.enums.filter((e) => wanted.some((w) => norm(w) === norm(e.value)));
      if (matched.length === 0) {
        const validos = f.enums.map((e) => `"${e.value}"`).join(", ");
        return `El campo "${f.name}" es una lista; valores válidos: ${validos || "(ninguno)"}.`;
      }
      const enumIds = f.type === "select" ? [matched[0].id] : matched.map((e) => e.id);
      await patchEntityFieldEnum("contacts", ctx.kommoContactId, f.id, enumIds, ctx.domain, ctx.token);
      return `Listo: actualicé "${f.name}" del contacto a ${matched.map((e) => `"${e.value}"`).join(", ")}.`;
    }
    await patchContactField(ctx.kommoContactId, f.id, value, ctx.domain, ctx.token);
    return `Listo: actualicé el campo "${f.name}" del contacto a "${value}".`;
  }

  if (name === "agregar_nota") {
    if (!ctx.gate.addNote) return "La acción 'agregar nota' está desactivada por el operador. No la realices.";
    if (ctx.kommoLeadId == null) return "No tengo el id de Kommo de este lead; no puedo agregar la nota.";
    const texto = String(input.texto ?? "").trim();
    if (!texto) return "ERROR_VALIDACION: falta 'texto'.";
    await addLeadNote(ctx.kommoLeadId, texto, ctx.domain, ctx.token);
    return "Listo: registré la nota interna en el lead (no visible para el cliente).";
  }

  if (name === "etiquetar_lead") {
    if (!ctx.gate.tag) return "La acción 'etiquetar lead' está desactivada por el operador. No la realices.";
    if (ctx.kommoLeadId == null) return "No tengo el id de Kommo de este lead; no puedo etiquetar.";
    const raw = input.etiquetas;
    const tags = Array.isArray(raw)
      ? raw.map((t) => String(t).trim()).filter(Boolean)
      : String(raw ?? "").split(/[,;]+/).map((t) => t.trim()).filter(Boolean);
    if (tags.length === 0) return "ERROR_VALIDACION: falta 'etiquetas'.";
    await addLeadTags(ctx.kommoLeadId, tags, ctx.domain, ctx.token);
    return `Listo: agregué la(s) etiqueta(s) ${tags.map((t) => `"${t}"`).join(", ")} al lead.`;
  }

  if (name === "transferir_asesor") {
    if (!ctx.gate.handoff) return "La acción 'transferir a asesor' está desactivada por el operador. No la realices.";
    if (ctx.kommoLeadId == null) return "No tengo el id de Kommo de este lead; no puedo transferir.";
    const motivo = String(input.motivo ?? "").trim();
    const etapaName = String(input.etapa ?? "").trim();
    const hechos: string[] = [];
    // 1) Apagar el agente para este lead (kill-switch configurado por el operador).
    if (ctx.agentOffFieldId != null) {
      await setLeadCheckboxField(ctx.kommoLeadId, ctx.agentOffFieldId, true, ctx.domain, ctx.token);
      hechos.push("apagué el agente para este lead");
    }
    // 2) Mover de etapa si se indicó una.
    if (etapaName) {
      const stages = await getStages(ctx.domain, ctx.token);
      const matches = stages.filter((s) => norm(s.name) === norm(etapaName));
      if (matches.length === 1) {
        await moveLeadStage(ctx.kommoLeadId, matches[0].id, matches[0].pipelineId, ctx.domain, ctx.token);
        hechos.push(`moví el lead a "${matches[0].name}"`);
      }
    }
    // 3) Nota interna con el motivo, para el asesor (fail-open: secundaria).
    if (motivo) {
      try {
        await addLeadNote(ctx.kommoLeadId, `Derivado a asesor: ${motivo}`, ctx.domain, ctx.token);
        hechos.push("dejé una nota para el asesor");
      } catch {
        // la nota es secundaria; no romper la derivación.
      }
    }
    return `Listo: derivé el lead a un asesor humano${hechos.length ? ` (${hechos.join("; ")})` : ""}. Decile al cliente que un asesor lo contactará a la brevedad.`;
  }

  return `Tool CRM desconocida: "${name}".`;
}

// ---------------- Shopify Tools (internas, gate por config) ----------------
// MÓDULO 4 — el agente consulta y vende sobre Shopify POR NOMBRE: buscar
// productos (categoría/talla/color/más vendidos), ver categorías, consultar
// pedidos y crear links de pago. Siempre declaradas; se ejecutan solo si el
// operador activó la capacidad (gate runtime en kommo_publish_config).

type ShopifyGate = {
  enabled: boolean; // master
  search: boolean; // buscar_producto + ver_categorias
  orders: boolean; // consultar_pedido
  checkout: boolean; // crear_link_pago
};

const SHOPIFY_TOOL_NAMES = new Set([
  "buscar_producto",
  "ver_categorias",
  "consultar_pedido",
  "crear_link_pago",
]);

// Tool interna de tasa de cambio (Módulo 5). Gate simple en kommo_publish_config.
const BCV_TOOL_NAME = "tasa_bcv";

function formatProducts(products: ShopifyProduct[]): string {
  return products
    .slice(0, 8)
    .map((p) => {
      const price =
        p.priceMin === p.priceMax
          ? `${p.priceMin} ${p.currency}`
          : `${p.priceMin}–${p.priceMax} ${p.currency}`;
      const vlist = p.variants
        .slice(0, 12)
        .map((v) => {
          const opt = v.options.map((o) => o.value).join("/") || v.title;
          const stock = v.available ? (v.qty != null ? `stock ${v.qty}` : "disponible") : "sin stock";
          return `${opt} (${stock})`;
        })
        .join(", ");
      return `• ${p.title} — ${price}${vlist ? `. Variantes: ${vlist}` : ""}${p.url ? `. Link: ${p.url}` : ""}${p.imageUrl ? `. Foto: ${p.imageUrl}` : ""}`;
    })
    .join("\n");
}

function formatOrders(orders: ShopifyOrder[]): string {
  return orders
    .map((o) => {
      const tr = o.tracking
        .filter((t) => t.number || t.url)
        .map((t) => `${t.company ?? "envío"} ${t.number ?? ""}${t.url ? ` (${t.url})` : ""}`.trim())
        .join("; ");
      return `Pedido ${o.name} — pago: ${o.financialStatus}, envío: ${o.fulfillmentStatus}, total: ${o.total} ${o.currency}${tr ? `. Seguimiento: ${tr}` : ""}`;
    })
    .join("\n");
}

// Ejecuta una tool de Shopify por nombre. Devuelve un string para el agente.
async function runShopifyTool(
  name: string,
  input: Record<string, unknown>,
  ctx: { creds: ShopifyCreds; gate: ShopifyGate }
): Promise<string> {
  if (!ctx.gate.enabled) {
    return "Las acciones de Shopify están DESACTIVADAS por el operador. No realices esta acción ni se la menciones al lead.";
  }

  if (name === "buscar_producto") {
    if (!ctx.gate.search) return "La consulta de catálogo de Shopify está desactivada por el operador.";
    const products = await searchProducts(ctx.creds, {
      consulta: input.consulta ? String(input.consulta) : "",
      talla: input.talla ? String(input.talla) : undefined,
      color: input.color ? String(input.color) : undefined,
      precioMax: typeof input.precio_max === "number" ? input.precio_max : undefined,
      orden: input.orden ? String(input.orden) : undefined,
      limit: 8,
    });
    if (products.length === 0) return "No encontré productos para esa búsqueda en la tienda.";
    return formatProducts(products);
  }

  if (name === "ver_categorias") {
    if (!ctx.gate.search) return "La consulta de catálogo de Shopify está desactivada por el operador.";
    const cols = await listCollections(ctx.creds);
    return cols.length
      ? `Categorías/colecciones de la tienda: ${cols.join(", ")}.`
      : "La tienda no tiene colecciones configuradas.";
  }

  if (name === "consultar_pedido") {
    if (!ctx.gate.orders) return "La consulta de pedidos de Shopify está desactivada por el operador.";
    const orders = await findOrders(ctx.creds, {
      numeroPedido: input.numero_pedido ? String(input.numero_pedido) : undefined,
      email: input.email ? String(input.email) : undefined,
      telefono: input.telefono ? String(input.telefono) : undefined,
    });
    if (orders.length === 0) return "No encontré pedidos con esos datos.";
    return formatOrders(orders);
  }

  if (name === "crear_link_pago") {
    if (!ctx.gate.checkout) return "La creación de links de pago está desactivada por el operador.";
    const producto = input.producto ? String(input.producto) : "";
    if (!producto) return "ERROR_VALIDACION: falta 'producto'.";
    const r = await createCheckoutLink(ctx.creds, {
      producto,
      talla: input.talla ? String(input.talla) : undefined,
      color: input.color ? String(input.color) : undefined,
      cantidad: typeof input.cantidad === "number" ? input.cantidad : undefined,
      email: input.email ? String(input.email) : undefined,
    });
    const variante = r.variantTitle && r.variantTitle !== "Default Title" ? ` (${r.variantTitle})` : "";
    return `Link de pago listo para ${r.productTitle}${variante}: ${r.invoiceUrl}`;
  }

  return `Tool de Shopify desconocida: "${name}".`;
}

// ---------------- Debounce + batching ----------------
// Un lead suele mandar varios mensajes cortados que son una sola idea. En vez
// de responder cada uno por separado, esperamos una ventana de silencio desde
// su último mensaje y respondemos TODOS juntos en un solo draft.
const DEBOUNCE_MS = 45 * 1000;
const MAX_BATCH = 15;
// Umbral de run muerto: holgado a propósito. Hoy un run con ~18 tool calls
// tarda ~140s; con 3min de umbral el sweep podía matar runs vivos lentos.
const STALE_MS = 8 * 60 * 1000;
// Tope de invocaciones del agente en paralelo (drafts 'generating' a la vez).
// Cada invocación procesa 1 lead; cuando reclama, dispara una hermana para el
// siguiente → cascada que drena la cola en paralelo y se frena en este tope.
// 15 ≈ ~13 leads/min de capacidad sin saturar Edge/Anthropic. Subir con cuidado.
const MAX_CONCURRENT = 15;

// Fan-out concurrente: tras reclamar un lead, si quedan más esperando y no
// superamos MAX_CONCURRENT runs en vuelo, disparamos otra generate-response para
// procesar el siguiente lead EN PARALELO (ya marcamos los mensajes de este, así
// que la hermana toma otro). Best-effort: cualquier error se traga, nunca rompe
// la respuesta en curso. Solo se llama tras un reclamo exitoso → sin runaway
// (una invocación que no reclama nada retorna antes y no dispara hermanas).
async function maybeFanOut(): Promise<void> {
  try {
    const { count } = await supabase
      .from("drafts")
      .select("id", { count: "exact", head: true })
      .eq("status", "pending")
      .contains("agent_metadata", { generating: true });
    if ((count ?? 0) >= MAX_CONCURRENT) return; // ya hay suficientes en vuelo

    const { data: more } = await supabase
      .from("messages")
      .select("id")
      .eq("direction", "inbound")
      .not("vertical_id", "is", null)
      .is("answered_by_draft_id", null)
      .eq("ignored", false)
      .limit(1);
    if (!more || more.length === 0) return; // nada más que procesar

    // verify_jwt=false en todas las functions → sin auth header.
    const sib = fetch(`${SUPABASE_URL}/functions/v1/generate-response`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
    // @ts-ignore: EdgeRuntime existe en Supabase
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(sib);
    }
  } catch (_e) {
    // best-effort: el fan-out nunca debe romper el flujo principal.
  }
}

const MSG_SELECT =
  "id, lead_id, content, source, vertical_id, classification, requires_human_review, created_at, is_comment, verticals(slug, auto_reply, requires_review)";

// deno-lint-ignore no-explicit-any
type MsgRow = any;

// Devuelve el set de message_ids bloqueados por un draft "real" y borra los
// drafts pending 'generating' stale (>3min = run muerto por desconexión).
async function reclaimStaleDrafts(msgIds: string[]): Promise<Set<string>> {
  if (msgIds.length === 0) return new Set();
  const { data: existing } = await supabase
    .from("drafts")
    .select("id, message_id, status, agent_metadata, created_at")
    .in("message_id", msgIds);
  const now = Date.now();
  const blocked = new Set<string>();
  const stale: string[] = [];
  for (const d of existing ?? []) {
    const meta = (d.agent_metadata ?? {}) as Record<string, unknown>;
    if (
      d.status === "pending" &&
      meta.generating === true &&
      now - new Date(d.created_at as string).getTime() > STALE_MS
    ) {
      stale.push(d.id as string);
    } else {
      blocked.add(d.message_id as string);
    }
  }
  // Guarda status=pending: si el run terminó (approved) entre el select y el
  // delete, el delete no borra nada — evita perder una respuesta ya publicada.
  if (stale.length > 0) {
    await supabase.from("drafts").delete().in("id", stale).eq("status", "pending");
  }
  return blocked;
}

type Batch = {
  leadId: string;
  messages: MsgRow[];
  vertical: { slug: string; auto_reply: boolean; requires_review: boolean };
};

// Cooldown + tope por lead. cooldownSeconds=0 y maxPerLead=0 → desactivado.
type Throttle = { cooldownSeconds: number; maxPerLead: number; windowHours: number };

// Cuenta las respuestas del agente realmente enviadas/aprobadas a un lead dentro
// de la ventana, y decide si hay que silenciar este turno. Fail-open ante error
// (nunca bloquea por una falla de lectura). Una respuesta = un draft del lead en
// estado approved/sent/auto_sent (los pending no cuentan: todavía no salieron).
async function checkLeadThrottle(
  leadId: string,
  t: Throttle
): Promise<{ blocked: boolean; reason?: string }> {
  if (t.cooldownSeconds <= 0 && t.maxPerLead <= 0) return { blocked: false };
  const now = Date.now();
  const windowStart = new Date(now - t.windowHours * 3_600_000).toISOString();
  const { data, error } = await supabase
    .from("drafts")
    .select("created_at, status, messages!inner(lead_id)")
    .eq("messages.lead_id", leadId)
    .in("status", ["approved", "sent", "auto_sent"])
    .gte("created_at", windowStart)
    .order("created_at", { ascending: false });
  if (error) {
    console.warn("checkLeadThrottle error — fail-open:", error.message);
    return { blocked: false };
  }
  const rows = (data ?? []) as Array<{ created_at: string }>;
  if (t.maxPerLead > 0 && rows.length >= t.maxPerLead) {
    return {
      blocked: true,
      reason: `max_responses_per_lead (${rows.length}/${t.maxPerLead} en ${t.windowHours}h)`,
    };
  }
  if (t.cooldownSeconds > 0 && rows.length > 0) {
    const lastTs = new Date(rows[0].created_at).getTime();
    const elapsed = Math.round((now - lastTs) / 1000);
    if (elapsed < t.cooldownSeconds) {
      return { blocked: true, reason: `cooldown (${elapsed}s < ${t.cooldownSeconds}s)` };
    }
  }
  return { blocked: false };
}

async function pickLeadBatch(
  messageId?: string,
  bypass = false,
  throttle?: Throttle,
  ignoredStageIds?: number[],
  debounceMs: number = DEBOUNCE_MS,
  maxAgeHours = 0
): Promise<Batch | null> {
  // --- Camino revisión humana: responder ESE mensaje + pendientes del lead ---
  // Es un override humano explícito (botón de revisión): si alguien pide
  // responder un mensaje puntual, lo respondemos aunque estuviera "ignored"
  // (los pendientes que se le suman SÍ filtran ignored, abajo). En la práctica
  // los ignorados no aparecen en revisión, así que este caso casi no ocurre.
  if (messageId) {
    const { data: m, error } = await supabase
      .from("messages")
      .select(MSG_SELECT)
      .eq("id", messageId)
      .single();
    if (error) throw new Error(`message ${messageId}: ${error.message}`);
    const { data: pend } = await supabase
      .from("messages")
      .select(MSG_SELECT)
      .eq("lead_id", m.lead_id)
      .eq("direction", "inbound")
      .not("vertical_id", "is", null)
      .is("answered_by_draft_id", null)
      .eq("ignored", false)
      .order("created_at", { ascending: true });
    let msgs = (pend ?? []) as MsgRow[];
    if (!msgs.find((x) => x.id === m.id)) {
      msgs = [...msgs, m].sort(
        (a, b) => +new Date(a.created_at) - +new Date(b.created_at)
      );
    }
    const blocked = await reclaimStaleDrafts(msgs.map((x) => x.id));
    msgs = msgs.filter((x) => !blocked.has(x.id));
    if (msgs.length === 0) return null;
    const latest = msgs[msgs.length - 1];
    if (!latest.verticals) return null;
    return { leadId: m.lead_id, messages: msgs.slice(-MAX_BATCH), vertical: latest.verticals };
  }

  // --- Modo cola con debounce ---
  // Barrido global de runs muertos ANTES de seleccionar: un draft 'generating'
  // stale tiene su batch marcado con answered_by_draft_id, así que esos
  // mensajes son invisibles para la query de abajo y reclaimStaleDrafts nunca
  // los recibe. Borrar el draft (FK on delete set null) libera el batch y este
  // mismo barrido lo retoma. Sin esto, un run muerto = lead sin respuesta
  // para siempre.
  {
    const cutoff = new Date(Date.now() - STALE_MS).toISOString();
    const { data: dead, error: sweepErr } = await supabase
      .from("drafts")
      .select("id")
      .eq("status", "pending")
      .contains("agent_metadata", { generating: true })
      .lt("created_at", cutoff);
    if (sweepErr) {
      console.warn("sweep select:", sweepErr.message);
    } else if (dead && dead.length > 0) {
      // Guarda status=pending también en el delete: si un run lento terminó
      // (approved) entre el select y acá, no se borra su respuesta.
      const { error: delErr } = await supabase
        .from("drafts")
        .delete()
        .in("id", dead.map((d) => d.id))
        .eq("status", "pending");
      if (delErr) console.warn("sweep delete:", delErr.message);
      else console.warn(`sweep: ${dead.length} draft(s) generating stale — batches liberados`);
    }
  }

  // El agente SIEMPRE genera borrador para todo mensaje no-ignorado (incluidos
  // los marcados requires_human_review). La revisión NO impide el borrador — se
  // refleja en el status del draft (pending = necesita aprobación humana) abajo.
  let q = supabase
    .from("messages")
    .select(MSG_SELECT)
    .eq("direction", "inbound")
    .not("vertical_id", "is", null)
    .is("answered_by_draft_id", null)
    .eq("ignored", false);
  // Ventana de frescura: solo atender mensajes recientes. Lo más viejo que la
  // ventana NO se responde (lo manejan los asesores) → no arrastra backlog.
  if (maxAgeHours > 0) {
    const freshCutoff = new Date(Date.now() - maxAgeHours * 3600_000).toISOString();
    q = q.gte("created_at", freshCutoff);
  }
  const { data, error } = await q
    .order("created_at", { ascending: true })
    .limit(200);
  if (error) throw new Error(`pick: ${error.message}`);
  if (!data || data.length === 0) return null;

  const blocked = await reclaimStaleDrafts(data.map((m: MsgRow) => m.id));
  const candidates = (data as MsgRow[]).filter((m) => !blocked.has(m.id));
  if (candidates.length === 0) return null;

  const byLead = new Map<string, MsgRow[]>();
  for (const m of candidates) {
    if (!byLead.has(m.lead_id)) byLead.set(m.lead_id, []);
    byLead.get(m.lead_id)!.push(m);
  }
  // Priorizar leads CALIENTES: el que escribió más recientemente, primero. Así
  // un comprador nuevo no espera detrás de conversaciones más viejas. La ventana
  // de frescura ya acota la cola, así que esto solo reordena dentro de lo fresco
  // (cada array de mensajes viene en orden ascendente → el último es el más nuevo).
  const newestTs = (msgs: MsgRow[]) => +new Date(msgs[msgs.length - 1].created_at as string);
  const leadsOrdered = [...byLead.entries()].sort(
    (a, b) => newestTs(b[1]) - newestTs(a[1])
  );

  const now = Date.now();
  for (const [leadId, msgs] of leadsOrdered) {
    // Debounce: el último inbound del lead (cualquiera) debe ser más viejo
    // que la ventana — si no, el lead todavía está escribiendo, esperamos.
    const { data: lastIn } = await supabase
      .from("messages")
      .select("created_at")
      .eq("lead_id", leadId)
      .eq("direction", "inbound")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const lastTs = lastIn ? new Date(lastIn.created_at as string).getTime() : 0;
    if (now - lastTs < debounceMs) continue;
    // Etapa ignorada: si el lead está en una etapa silenciada de Kommo, el
    // agente no atiende. Stage null = atiende (igual que el gate de follow-up).
    if (ignoredStageIds && ignoredStageIds.length > 0) {
      const { data: ld } = await supabase
        .from("leads")
        .select("kommo_stage_id")
        .eq("id", leadId)
        .maybeSingle();
      const stage = ld?.kommo_stage_id;
      if (stage != null && ignoredStageIds.includes(Number(stage))) continue;
    }
    // Cooldown / tope por lead: si este lead está silenciado, lo SALTAMOS y
    // seguimos con el próximo (no cortamos la cola — eso mataría de hambre a los
    // demás leads). Sus mensajes quedan sin contestar y el sweep los retoma
    // cuando pase la ventana.
    if (throttle) {
      const gate = await checkLeadThrottle(leadId, throttle);
      if (gate.blocked) continue;
    }
    const latest = msgs[msgs.length - 1];
    if (!latest.verticals) continue;
    return { leadId, messages: msgs.slice(-MAX_BATCH), vertical: latest.verticals };
  }
  return null;
}

// ---------------- Lead info ----------------
async function getLead(leadId: string) {
  const { data, error } = await supabase
    .from("leads")
    .select("id, kommo_lead_id, kommo_contact_id, display_name, channel, kommo_stage_id, gender, age, age_band")
    .eq("id", leadId)
    .single();
  if (error) throw new Error(`lead ${leadId}: ${error.message}`);
  return data;
}

// Fecha y hora actual en la zona horaria del operador, en español. El modelo
// tiene knowledge cutoff y no sabe "hoy": se la inyectamos en cada sesión.
function formatNow(timezone: string): string {
  const now = new Date();
  try {
    return new Intl.DateTimeFormat("es", {
      timeZone: timezone,
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(now);
  } catch {
    return now.toISOString();
  }
}

// ---------------- Helpers de promociones/eventos ----------------
type PromoRow = {
  name: string; content: string; kind: "promo" | "evento" | "situacion";
  starts_at: string | null; ends_at: string | null; weekdays: number[] | null;
};

// Fecha local YYYY-MM-DD + isodow en el TZ (mismo motor que business-hours.ts).
function localDateParts(timezone: string): { ymd: string; isodow: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`; // en-CA → ISO
  const isodow = ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 } as Record<string, number>)[get("weekday")] ?? 0;
  return { ymd, isodow };
}

// ends_at INCLUSIVE; weekdays ANY; sin rango/sin weekdays = no restringe.
function isPromotionActiveToday(p: PromoRow, today: { ymd: string; isodow: number }): boolean {
  if (p.starts_at && today.ymd < p.starts_at) return false;
  if (p.ends_at && today.ymd > p.ends_at) return false;          // inclusive
  if (p.weekdays && p.weekdays.length > 0 && !p.weekdays.includes(today.isodow)) return false;
  return true;
}

// Evento que empieza en (hoy, hoy+7]: próximo, no activo aún.
function isUpcomingEvent(p: PromoRow, today: { ymd: string }): boolean {
  if (p.kind !== "evento" || !p.starts_at) return false;
  if (p.starts_at <= today.ymd) return false;                    // ya empezó → lo maneja activeToday
  const limit = new Date(today.ymd + "T00:00:00Z");
  limit.setUTCDate(limit.getUTCDate() + 7);
  return p.starts_at <= limit.toISOString().slice(0, 10);
}

const PROMO_CAP = 8;
const PROMO_TRUNC = 250;
function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

function buildPromoContext(rows: PromoRow[], timezone: string): {
  activePromos: string | null; upcomingEvents: string | null; activeSituations: string | null;
} {
  const today = localDateParts(timezone);
  const activeToday = rows.filter((p) => isPromotionActiveToday(p, today));
  // promo/evento activos → mención opcional; situaciones → restricción aparte.
  const active = activeToday.filter((p) => p.kind !== "situacion").slice(0, PROMO_CAP)
    .map((p) => `- ${p.name}: ${truncate(p.content, PROMO_TRUNC)}`);
  const situations = activeToday.filter((p) => p.kind === "situacion").slice(0, PROMO_CAP)
    .map((p) => `- ${p.name}: ${truncate(p.content, PROMO_TRUNC)}`);
  const upcoming = rows.filter((p) => isUpcomingEvent(p, today)).slice(0, PROMO_CAP)
    .map((p) => `- ${p.name} (desde ${p.starts_at}): ${truncate(p.content, PROMO_TRUNC)}`);
  return {
    activePromos: active.length ? active.join("\n") : null,
    upcomingEvents: upcoming.length ? upcoming.join("\n") : null,
    activeSituations: situations.length ? situations.join("\n") : null,
  };
}

// ---------------- Catálogo de vehículos ----------------
// El agente SOLO puede ofrecer/hablar de los vehículos activos de la tabla
// `vehicles`. Se inyecta entero en cada sesión (catálogo chico) — no requiere
// search_kb. Si el lead pregunta por algo fuera de esta lista, el agente lo
// deriva en vez de inventar.
type VehicleRow = {
  name: string;
  price_usd: number | null;
  description: string | null;
};

function formatUsd(price: number | null): string {
  if (price === null || price === undefined) return "consultar";
  return "Desde $" + Math.round(price).toLocaleString("en-US");
}

function buildVehicleCatalog(rows: VehicleRow[]): string | null {
  if (!rows.length) return null;
  return rows
    .map((v) => `- ${v.name} — ${formatUsd(v.price_usd)}${v.description ? `: ${v.description.trim()}` : ""}`)
    .join("\n");
}

// Datos que YA están en Kommo (teléfono/email + custom fields no vacíos), para
// que el agente no los vuelva a pedir. Teléfono/email se listan SIEMPRE (incluso
// "(no registrado)") así el agente sabe a ciencia cierta qué falta y qué no.
const KNOWN_FIELDS_CAP = 12;
function buildKnownDataBlock(d: KnownLeadData): string {
  const lines: string[] = [
    `- teléfono: ${d.phones.length ? d.phones.join(" / ") : "(no registrado)"}`,
    `- email: ${d.emails.length ? d.emails.join(" / ") : "(no registrado)"}`,
  ];
  for (const f of d.fields.slice(0, KNOWN_FIELDS_CAP)) {
    lines.push(`- ${f.name}: ${truncate(f.value, 120)}`);
  }
  return lines.join("\n");
}

// ---------------- Construir contexto user.message ----------------
function buildContext(opts: {
  lead: {
    id: string;
    display_name: string | null;
    channel: string | null;
    gender?: string | null;
    age?: number | null;
    age_band?: string | null;
  };
  messages: Array<{ content: string; created_at: string }>;
  verticalSlug: string;
  channel: string | null;
  classification: Record<string, unknown> | null;
  masterPath: string;
  leadsPath: string;
  now: string;
  timezone: string;
  businessHours: { active: boolean; label: string };
  activePromos: string | null;
  upcomingEvents: string | null;
  activeSituations: string | null;
  vehicleCatalog: string | null;
  knownData: string | null;
  commentInstructions?: string | null;
}) {
  const cls = opts.classification ?? {};
  const multi = opts.messages.length > 1;
  const block = multi
    ? opts.messages
        .map(
          (m, i) =>
            `(${i + 1}) [${new Date(m.created_at).toISOString().slice(11, 16)}] ${m.content}`
        )
        .join("\n")
    : opts.messages[0]?.content ?? "";

  const header = multi
    ? `[MENSAJES DEL LEAD — ${opts.messages.length} mensajes seguidos, trátalos como UNA sola conversación y responde de forma unificada, no uno por uno]`
    : `[MENSAJE DEL LEAD]`;

  return `[CONTEXTO]
fecha_hora_actual: ${opts.now} (zona horaria ${opts.timezone})
en_horario_laboral: ${opts.businessHours.active ? "sí" : "no"} (${opts.businessHours.label}). Si es "no" y el lead necesita un asesor humano, avisale que el equipo lo contacta apenas retome el horario de atención — no prometas transferencia inmediata.
${opts.activeSituations ? `situaciones_vigentes (CRÍTICO — restricciones operativas reales de HOY; respetalas SIEMPRE, NO son ofertas):\n${opts.activeSituations}\nREGLA: nunca contradigas una situación vigente (p. ej. si dice "hoy cerrado", NO ofrezcas visita ni atención presencial hoy). Si la conversación lo amerita, avisá con naturalidad y empatía y ofrecé la alternativa (seguir por acá, coordinar para otro día).\n` : ""}${opts.activePromos ? `promociones_activas (mencionalas solo si vienen al caso de lo que pregunta el lead):\n${opts.activePromos}` : "promociones_activas: ninguna"}${opts.upcomingEvents ? `\neventos_proximos (podes anticiparlos si aportan a la conversacion):\n${opts.upcomingEvents}` : ""}${opts.vehicleCatalog ? `\ncatalogo_vehiculos (ÚNICOS modelos que comercializa el concesionario; precios "Desde" referenciales en USD):\n${opts.vehicleCatalog}\nREGLA: respondé SOLO sobre estos vehículos. Si el lead pregunta por un modelo/marca que no está en esta lista, aclará que no lo manejamos y ofrecé las alternativas del catálogo o derivá a un asesor — nunca inventes precios, modelos ni especificaciones fuera de esta lista.` : ""}${opts.commentInstructions != null ? `\norigen_comentario_instagram: sí — ${opts.commentInstructions}` : ""}
lead_id: ${opts.lead.id}
lead_name: ${opts.lead.display_name ?? "(desconocido)"}
${opts.knownData ? `datos_conocidos_del_lead (YA están en Kommo — NO los vuelvas a pedir. Pedí SOLO lo que figure como "(no registrado)" o lo que realmente falte; si necesitás verificar un dato, confirmá el valor que ya figura acá en vez de preguntarlo de cero):\n${opts.knownData}\n` : ""}genero_lead: ${opts.lead.gender ?? "desconocido"} (inferido del nombre). Tratá a la persona con la concordancia correcta (bienvenido/bienvenida, etc.); si es "desconocido", usá trato neutro SIN marcar género ni asumirlo.
edad_lead: ${opts.lead.age ? `${opts.lead.age} años` : "desconocida"}
registro_sugerido: ${opts.lead.age_band === "mayor" ? "formal, pausado y explicativo (persona mayor) — explicá cada paso con claridad, sin tecnicismos" : opts.lead.age_band === "joven" ? "casual y cercano (persona joven) — mantené tu tono natural" : "normal (tu registro habitual)"}. Podés ajustar el registro si la conversación da otras señales de edad.
vertical: ${opts.verticalSlug}
channel: ${opts.channel ?? "unknown"}
intent: ${cls.intent ?? "?"}
urgency: ${cls.urgency ?? "?"}
toxicity: ${cls.toxicity ?? "?"}
confidence: ${cls.confidence ?? "?"}
classifier_reasoning: ${cls.reasoning ?? "?"}

${header}
"""
${block}
"""

Procede según tu system prompt: revisa ${opts.masterPath}/voice/ y ${opts.masterPath}/dreams/ para reglas, lee la memoria del lead si existe, usa search_kb si la pregunta es factual, redacta la respuesta con la voz definida en tu system prompt, actualiza ${opts.leadsPath}/${opts.lead.id}/. Usá fecha_hora_actual para cualquier cosa relativa al tiempo (hoy, mañana, vencimientos, horarios, días de demora).

Tu MENSAJE FINAL debe ser SOLO el texto que se envía al lead, envuelto OBLIGATORIAMENTE en los tags <respuesta>…</respuesta> (sin nada antes ni después). Escribí el mensaje DIRIGIDO al cliente (tuteo, en segunda persona), NO un resumen de lo que hiciste. PROHIBIDO: narrar tus acciones o hablar del lead en tercera persona (ej: "¡Listo! He respondido a <nombre> con…", "He creado la memoria del lead…", "La respuesta va dentro del horario…"). Eso NO es la respuesta — la planificación va en mensajes ANTERIORES. Si no hay tags <respuesta> tu salida se descarta y va a revisión humana.`;
}

// ---------------- Orquestar sesión CMA ----------------
type Outcome = {
  responseText: string;
  rawResponseText: string;
  // false si el agente NO emitió los tags <respuesta>…</respuesta> (output
  // malformado / meta-narración). En ese caso NO se auto-publica.
  hadRespuesta: boolean;
  toolCalls: number;
  durationMs: number;
  sessionId: string;
};

async function runAgent(opts: {
  leadId: string;
  contextMessage: string;
  agentId: string;
  environmentId: string;
  memstoreMaster: string;
  memstoreLeads: string;
  anthropic: Anthropic;
  httpTools: HttpToolRow[];
  cfg: ConfigReader;
  kommoLeadId: number | null;
  kommoContactId: number | null;
  crm: CrmGate;
  agentOffFieldId: number | null;
  shopify: ShopifyGate;
  bcvEnabled: boolean;
  // Campos para registrar lead_stage_events cuando el agente mueve etapas
  currentKommoStageId?: number | null;
  draftId?: string;
}): Promise<Outcome> {
  const start = Date.now();

  // 1) Crear sesión con ambos memory stores
  const session = await opts.anthropic.beta.sessions.create({
    agent: opts.agentId,
    environment_id: opts.environmentId,
    title: `respond ${opts.leadId.slice(0, 8)} ${new Date().toISOString()}`,
    resources: [
      {
        type: "memory_store",
        memory_store_id: opts.memstoreMaster,
        access: "read_only",
        instructions: `Voz del operador (reglas + ejemplos) en /voice/. Knowledge base destilada en /kb/. Aprendizajes de Dreams en /dreams/. Consultá antes de redactar.`,
      },
      {
        type: "memory_store",
        memory_store_id: opts.memstoreLeads,
        access: "read_write",
        instructions: `Memoria por lead. El lead actual es ${opts.leadId}. Leé /${opts.leadId}/conversation.md y /${opts.leadId}/learnings.md si existen. Después de responder, escribí turn nuevo a conversation.md (formato: '## YYYY-MM-DD HH:MM\\nLead: <msg>\\nAgente: <respuesta>\\n').`,
      },
    ],
  });

  // 2) Abrir stream PRIMERO, después enviar mensaje
  const [, , stream] = await Promise.all([
    Promise.resolve(),
    Promise.resolve(),
    opts.anthropic.beta.sessions.events.stream(session.id),
  ]);

  await opts.anthropic.beta.sessions.events.send(session.id, {
    events: [
      {
        type: "user.message",
        content: [{ type: "text", text: opts.contextMessage }],
      },
    ],
  });

  // 3) Loop de eventos
  let responseText = "";
  let toolCalls = 0;

  for await (const event of stream) {
    // deno-lint-ignore no-explicit-any
    const ev = event as any;
    if (ev.type === "agent.message") {
      // Reset: nos quedamos con el ÚLTIMO agent.message
      // (mensajes intermedios suelen ser razonamiento previo a tool calls)
      responseText = "";
      for (const block of ev.content ?? []) {
        if (block.type === "text") responseText += block.text;
      }
    } else if (ev.type === "agent.custom_tool_use") {
      toolCalls++;
      try {
        let result: string;
        if (ev.name === "search_kb") {
          result = await runSearchKb(ev.input ?? {});
        } else if (CRM_TOOL_NAMES.has(ev.name)) {
          // Tools internas que operan Kommo (mover_etapa / actualizar_lead /
          // actualizar_contacto). Gate de seguridad por config (runtime).
          const domain = opts.cfg.get("KOMMO_API_DOMAIN");
          const token = opts.cfg.get("KOMMO_ACCESS_TOKEN");
          result = !domain || !token
            ? "Kommo no está conectado; no puedo operar el CRM."
            : await runCrmTool(ev.name, ev.input ?? {}, {
                kommoLeadId: opts.kommoLeadId,
                kommoContactId: opts.kommoContactId,
                domain,
                token,
                gate: opts.crm,
                agentOffFieldId: opts.agentOffFieldId,
                internalLeadId: opts.leadId,
                currentKommoStageId: opts.currentKommoStageId,
                draftId: opts.draftId,
              });
        } else if (SHOPIFY_TOOL_NAMES.has(ev.name)) {
          // Tools internas que consultan/venden sobre Shopify. Gate por config.
          // resolveShopifyCreds maneja token estático legacy o client
          // credentials grant (token de 24h cacheado en module scope).
          const creds = await resolveShopifyCreds(opts.cfg);
          result = !creds
            ? "Shopify no está conectado; no puedo consultar la tienda."
            : await runShopifyTool(ev.name, ev.input ?? {}, {
                creds,
                gate: opts.shopify,
              });
        } else if (ev.name === BCV_TOOL_NAME) {
          // Tasa USD→VES (BCV). Gate por config; cache 6h en _shared/exchange.
          if (!opts.bcvEnabled) {
            result = "La consulta de tasa de cambio está desactivada por el operador. No la realices ni menciones que existe.";
          } else {
            try {
              const r = await getBcvRate(opts.cfg);
              result = `Tasa oficial BCV vigente: 1 USD = ${r.rate} Bs (fuente: ${r.source}, obtenida: ${r.fetchedAt}). Usala como referencia aproximada del día; el monto exacto en bolívares lo confirma el operador al cobrar.`;
            } catch (err) {
              // El detalle (status HTTP, fuente custom) va al log, NO al agente:
              // el tool result puede terminar relayado textual al cliente final.
              console.error("tasa_bcv:", err instanceof Error ? err.message : err);
              result =
                "No pude obtener la tasa de cambio en este momento. Decile al cliente que el monto en bolívares se confirma al coordinar el pago.";
            }
          }
        } else {
          // Generic HTTP tool executor: look up by name in the 60s-TTL cache.
          // Completely DB-driven — no per-tool code, no hardcoded names here.
          const tool = opts.httpTools.find((t) => t.name === ev.name);
          result = tool
            ? await runHttpTool(tool, ev.input ?? {}, opts.cfg)
            : `Tool desconocida: "${ev.name}". La tool no está registrada o está deshabilitada.`;
        }
        await opts.anthropic.beta.sessions.events.send(session.id, {
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: ev.id,
              content: [{ type: "text", text: result }],
            },
          ],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await opts.anthropic.beta.sessions.events.send(session.id, {
          events: [
            {
              type: "user.custom_tool_result",
              custom_tool_use_id: ev.id,
              content: [{ type: "text", text: `ERROR: ${msg}` }],
              is_error: true,
            },
          ],
        });
      }
    } else if (ev.type === "session.status_idle") {
      const stop = ev.stop_reason?.type;
      if (stop !== "requires_action") break;
    } else if (ev.type === "session.status_terminated") {
      break;
    } else if (ev.type === "session.error") {
      const msg = ev.error?.message ?? "session error";
      throw new Error(msg);
    }
  }

  // Extraer SOLO lo que está dentro de <respuesta>...</respuesta>.
  // Si NO hay tags, el output está malformado (el modelo a veces narra sus
  // acciones — "He respondido a X con…" — en vez de responder). Devolvemos
  // hadRespuesta=false para que el caller NO lo auto-publique (va a revisión).
  const match = responseText.match(/<respuesta>([\s\S]*?)<\/respuesta>/i);
  const hadRespuesta = match != null;
  const clean = (match ? match[1] : responseText).trim();

  return {
    responseText: clean,
    rawResponseText: responseText.trim(),
    hadRespuesta,
    toolCalls,
    durationMs: Date.now() - start,
    sessionId: session.id,
  };
}

// ---------------- Entry point ----------------
Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response("generate-response OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  let body: { message_id?: string; force_review?: boolean } = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    // ignore
  }
  const forceReview = body.force_review === true;

  // Kill switch: si el agente está deshabilitado en config, no genera nada.
  // (publishing_enabled se controla aparte en publish-to-kommo.)
  const { data: cfg } = await supabase
    .from("kommo_publish_config")
    .select(
      "agent_enabled, bypass_review, publishing_enabled, response_cooldown_seconds, max_responses_per_lead, cooldown_window_hours, ignored_stage_ids, response_debounce_seconds, answer_max_age_hours, crm_actions_enabled, crm_can_move_stage, crm_can_update_lead, crm_can_update_contact, crm_can_add_note, crm_can_handoff, crm_can_tag, agent_off_field_id, shopify_actions_enabled, shopify_can_search, shopify_can_orders, shopify_can_checkout, bcv_rate_enabled, comment_instructions, comment_reply_enabled, comment_reply_rules"
    )
    .eq("is_active", true)
    .maybeSingle();

  // Zona horaria + horario laboral del operador (follow_up_config es la single
  // source of truth: la edita /agent y la consume también follow-up-scan).
  const { data: fuCfg } = await supabase
    .from("follow_up_config")
    .select("timezone, business_hours, business_hours_start, business_hours_end, active_days")
    .eq("is_active", true)
    .maybeSingle();
  const timezone = (fuCfg?.timezone as string) || "America/Guayaquil";
  const bizCfg: BusinessHoursConfig = {
    timezone,
    business_hours: (fuCfg?.business_hours as BusinessHoursConfig["business_hours"]) ?? null,
    business_hours_start: Number(fuCfg?.business_hours_start ?? 9),
    business_hours_end: Number(fuCfg?.business_hours_end ?? 20),
    active_days: ((fuCfg?.active_days as number[] | null) ?? [1, 2, 3, 4, 5, 6]).map(Number),
  };

  if (cfg && cfg.agent_enabled === false) {
    return new Response(
      JSON.stringify({ ok: true, picked: null, skipped: "agent disabled" }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }

  // Bypass de review: solo tiene efecto si publishing está habilitado.
  // No aplica al camino de revisión humana explícita (forceReview).
  const bypass =
    !forceReview &&
    cfg?.bypass_review === true &&
    cfg?.publishing_enabled === true;

  // Cooldown / tope por lead (no aplica al camino de revisión humana explícita).
  const throttle: Throttle | undefined = forceReview
    ? undefined
    : {
        cooldownSeconds: Number(cfg?.response_cooldown_seconds ?? 0) || 0,
        maxPerLead: Number(cfg?.max_responses_per_lead ?? 0) || 0,
        windowHours: Number(cfg?.cooldown_window_hours ?? 24) || 24,
      };

  // Etapas ignoradas (tampoco aplica a revisión humana explícita).
  const ignoredStageIds: number[] | undefined = forceReview
    ? undefined
    : (((cfg?.ignored_stage_ids ?? []) as unknown[]).map(Number).filter((n) => Number.isFinite(n)));

  // Debounce configurable: segundos de silencio a esperar antes de responder el
  // batch. Default 45s. No aplica al camino de revisión humana explícita.
  const debounceMs = forceReview
    ? 0
    : Math.max(0, Number(cfg?.response_debounce_seconds ?? 45)) * 1000;

  // Ventana de frescura: el agente solo atiende mensajes de las últimas N horas
  // (lo más viejo lo manejan los asesores). Default 1h. No aplica a revisión
  // humana explícita (esa responde el mensaje pedido sin importar su antigüedad).
  const maxAgeHours = forceReview ? 0 : Math.max(0, Number(cfg?.answer_max_age_hours ?? 1));

  // Gate de las acciones de CRM (Módulo 3). Default OFF: el agente no toca el
  // CRM hasta que el operador active master + la capacidad puntual.
  const crm: CrmGate = {
    enabled: cfg?.crm_actions_enabled === true,
    moveStage: cfg?.crm_can_move_stage === true,
    updateLead: cfg?.crm_can_update_lead === true,
    updateContact: cfg?.crm_can_update_contact === true,
    addNote: cfg?.crm_can_add_note === true,
    handoff: cfg?.crm_can_handoff === true,
    tag: cfg?.crm_can_tag === true,
  };
  const agentOffFieldId =
    cfg?.agent_off_field_id != null ? Number(cfg.agent_off_field_id) : null;

  // Gate de Shopify (Módulo 4). Default OFF.
  const shopify: ShopifyGate = {
    enabled: cfg?.shopify_actions_enabled === true,
    search: cfg?.shopify_can_search === true,
    orders: cfg?.shopify_can_orders === true,
    checkout: cfg?.shopify_can_checkout === true,
  };

  const batch = await pickLeadBatch(body.message_id, bypass, throttle, ignoredStageIds, debounceMs, maxAgeHours);
  if (!batch) {
    return new Response(JSON.stringify({ ok: true, picked: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }

  const vertical = batch.vertical;
  const batchMsgs = batch.messages as MsgRow[];
  const latestMsg = batchMsgs[batchMsgs.length - 1];
  const batchIds = batchMsgs.map((m) => m.id as string);

  // Un solo draft por batch, anclado al mensaje MÁS RECIENTE del lead.
  const { data: draft, error: draftErr } = await supabase
    .from("drafts")
    .insert({
      message_id: latestMsg.id,
      body: "",
      status: "pending",
      agent_metadata: { generating: true, batch_size: batchMsgs.length },
    })
    .select("id")
    .single();
  if (draftErr || !draft) {
    return new Response(
      JSON.stringify({ ok: false, error: `draft insert: ${draftErr?.message}` }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  // Marcar TODOS los mensajes del batch como cubiertos por este draft, para
  // que el barrido no los vuelva a tomar (si el draft se borra por stale,
  // el FK on delete set null los libera y se reprocesan).
  await supabase
    .from("messages")
    .update({ answered_by_draft_id: draft.id })
    .in("id", batchIds);

  // Ya reclamamos este lead → disparamos una hermana para el siguiente, en
  // paralelo (hasta MAX_CONCURRENT). Así una ráfaga de leads se atiende junta
  // en vez de de a uno por minuto. Best-effort: no bloquea ni rompe nada.
  await maybeFanOut();

  // CRITICAL: resolve ALL config values BEFORE EdgeRuntime.waitUntil(slowWork).
  // After waitUntil the client has disconnected; any async I/O failure here
  // would leave the draft stuck 'pending'. Resolving before the boundary means
  // a config error surfaces synchronously and the draft can be cleaned up.
  let agentId!: string, environmentId!: string, memstoreMaster!: string, memstoreLeads!: string;
  let masterPath!: string, leadsPath!: string, anthropic!: Anthropic;
  let httpTools: HttpToolRow[] = [];
  let resolvedCfg!: ConfigReader;
  try {
    const runtimeCfg = await loadConfig(supabase);
    resolvedCfg = runtimeCfg;
    agentId = runtimeCfg.require("ANTHROPIC_AGENT_ID");
    environmentId = runtimeCfg.require("ANTHROPIC_ENVIRONMENT_ID");
    memstoreMaster = runtimeCfg.require("ANTHROPIC_MEMORY_MASTER_ID");
    memstoreLeads = runtimeCfg.require("ANTHROPIC_MEMORY_LEADS_ID");
    const masterStoreName = runtimeCfg.getOr("MEMORY_STORE_MASTER_NAME", "master");
    const leadsStoreName = runtimeCfg.getOr("MEMORY_STORE_LEADS_NAME", "leads");
    masterPath = `/mnt/memory/${masterStoreName}`;
    leadsPath = `/mnt/memory/${leadsStoreName}`;
    anthropic = new Anthropic({ apiKey: runtimeCfg.require("ANTHROPIC_API_KEY") });
    // Load enabled HTTP tools BEFORE the waitUntil boundary so new tools
    // (pure DB data) work immediately without edge-function redeploy.
    httpTools = await loadHttpTools(supabase);
  } catch (configErr) {
    const errMsg = configErr instanceof Error ? configErr.message : String(configErr);
    // Mark draft as failed so it doesn't stay stuck 'pending'.
    await supabase
      .from("drafts")
      .update({ status: "failed", agent_metadata: { error: `config: ${errMsg}` } })
      .eq("id", draft.id);
    console.error("generate-response config resolution failed:", errMsg);
    return new Response(
      JSON.stringify({ ok: false, error: `config: ${errMsg}` }),
      { status: 500, headers: { "content-type": "application/json" } }
    );
  }

  // El trabajo del agente tarda 60-80s. Si lo hiciéramos antes de responder,
  // el runtime mata la función cuando el cliente (pg_net / fire-and-forget) se
  // desconecta, dejando el draft 'pending' para siempre. Por eso devolvemos 200
  // de inmediato y corremos el trabajo lento bajo EdgeRuntime.waitUntil, que
  // mantiene la función viva hasta que termine aunque el cliente se vaya.
  const slowWork = (async () => {
    try {
      const lead = await getLead(batch.leadId);
      const { data: rawPromos } = await supabase
        .from("promotions")
        .select("name, content, kind, starts_at, ends_at, weekdays")
        .eq("enabled", true);
      const promoCtx = buildPromoContext((rawPromos ?? []) as PromoRow[], timezone);
      // Catálogo de vehículos activos — el agente solo puede ofrecer estos.
      const { data: rawVehicles } = await supabase
        .from("vehicles")
        .select("name, price_usd, description")
        .eq("enabled", true)
        .order("sort_order")
        .order("name");
      const vehicleCatalog = buildVehicleCatalog((rawVehicles ?? []) as VehicleRow[]);

      // Datos que YA están en Kommo (teléfono/email + custom fields del lead y su
      // contacto) → el agente no los vuelve a pedir. Read-only, fail-open: si Kommo
      // no está conectado o no responde, el agente sigue sin este bloque.
      let knownData: string | null = null;
      try {
        const kDomain = resolvedCfg.get("KOMMO_API_DOMAIN");
        const kToken = resolvedCfg.get("KOMMO_ACCESS_TOKEN");
        if (kDomain && kToken && (lead.kommo_lead_id != null || lead.kommo_contact_id != null)) {
          const known = await fetchKnownLeadData(
            lead.kommo_lead_id != null ? Number(lead.kommo_lead_id) : null,
            lead.kommo_contact_id != null ? Number(lead.kommo_contact_id) : null,
            kDomain,
            kToken
          );
          knownData = buildKnownDataBlock(known);
        }
      } catch (_e) {
        // fail-open
      }

      // Detección de comentario: si ALGÚN mensaje del batch tiene is_comment=true,
      // inyectamos comment_instructions al agente. LÍNEA ROJA: solo esto cambia
      // del flujo normal (sweep/debounce/guardas/promos/usage intactos).
      const batchHasComment = batchMsgs.some((m) => m.is_comment === true);
      let commentInstructions: string | null = null;
      if (batchHasComment) {
        const rawInstructions = (cfg as Record<string, unknown> | null)?.comment_instructions;
        commentInstructions = typeof rawInstructions === "string" && rawInstructions.trim()
          ? rawInstructions.trim()
          : "El mensaje vino de un comentario público en una publicación de Instagram. Tu respuesta sale por DM: reconocé el origen con naturalidad (ej: \"vi tu comentario 😊\"), andá directo al grano.";
      }

      const contextMessage = buildContext({
        lead,
        messages: batchMsgs.map((m) => ({
          content: m.content as string,
          created_at: m.created_at as string,
        })),
        verticalSlug: vertical.slug,
        channel: latestMsg.source,
        classification: latestMsg.classification as Record<string, unknown> | null,
        masterPath,
        leadsPath,
        now: formatNow(timezone),
        timezone,
        businessHours: {
          active: isBusinessHours(bizCfg),
          label: businessHoursLabel(bizCfg),
        },
        activePromos: promoCtx.activePromos,
        upcomingEvents: promoCtx.upcomingEvents,
        activeSituations: promoCtx.activeSituations,
        vehicleCatalog,
        knownData,
        commentInstructions,
      });

      const outcome = await runAgent({
        leadId: batch.leadId,
        contextMessage,
        agentId,
        environmentId,
        memstoreMaster,
        memstoreLeads,
        anthropic,
        httpTools,
        cfg: resolvedCfg,
        kommoLeadId: lead.kommo_lead_id != null ? Number(lead.kommo_lead_id) : null,
        kommoContactId: lead.kommo_contact_id != null ? Number(lead.kommo_contact_id) : null,
        crm,
        agentOffFieldId,
        shopify,
        bcvEnabled: cfg?.bcv_rate_enabled === true,
        currentKommoStageId: lead.kommo_stage_id != null ? Number(lead.kommo_stage_id) : null,
        draftId: draft.id,
      });

      if (!outcome.responseText) {
        throw new Error("agent devolvió respuesta vacía");
      }

      // ---- Respuesta pública IA (comentario de Instagram) — fail-open ----
      // Si el batch vino de un comentario y el operador tiene la feature activa,
      // generamos una respuesta pública corta con Haiku gobernada por sus reglas.
      // CAP DURO: 280 chars. Falla → sin public_reply (el DM sigue igual).
      let publicReply: string | undefined;
      if (
        batchHasComment &&
        (cfg as Record<string, unknown> | null)?.comment_reply_enabled === true
      ) {
        const rawRules = (cfg as Record<string, unknown> | null)?.comment_reply_rules;
        const replyRules = typeof rawRules === "string" && rawRules.trim()
          ? rawRules.trim()
          : "Respuesta CORTA (máximo 200 caracteres), sin saludos largos ni presentaciones: directo al grano. NO des precios, montos ni promociones con números en público — para eso invitá al DM (\"te pasamos el detalle por DM 💛\"). Tono cercano, máximo 1 emoji. Si el comentario es solo elogio o emojis, agradecé breve.";
        try {
          const operator = resolvedCfg.getOr("OPERATOR_NAME", "el negocio");
          // Modelo de la respuesta pública: editable desde /consumo.
          const commentReplyModel = resolvedCfg.getOr("COMMENT_REPLY_MODEL", "claude-haiku-4-5");
          const batchText = batchMsgs.map((m: MsgRow) => String(m.content ?? "").trim()).filter(Boolean).join(" | ");
          const dmPreview = outcome.responseText.slice(0, 500);
          const haikuStart = Date.now();
          const haikuRes = await anthropic.messages.create({
            model: commentReplyModel,
            max_tokens: 200,
            system: `Sos el community manager de ${operator}. Redactás UNA respuesta pública a un comentario de Instagram. Reglas OBLIGATORIAS del negocio:\n${replyRules}\nRespondé SOLO con el texto del comentario de respuesta, sin comillas ni explicaciones.`,
            messages: [
              {
                role: "user",
                content: `Comentario del cliente: "${batchText}"\n\nLa respuesta completa que le enviaremos por DM (para tu contexto, NO la repitas): "${dmPreview}"`,
              },
            ],
          });
          const rawReply = (haikuRes.content[0]?.type === "text" ? haikuRes.content[0].text : "").trim();
          if (rawReply) {
            // Cap duro 280 chars: cortar en el último espacio antes del límite.
            if (rawReply.length <= 280) {
              publicReply = rawReply;
            } else {
              const sub = rawReply.slice(0, 280);
              const lastSpace = sub.lastIndexOf(" ");
              publicReply = lastSpace > 0 ? sub.slice(0, lastSpace) : sub;
            }
          }
          // Registrar consumo de Haiku — fail-open.
          await recordUsage(supabase, {
            component: "comment_reply",
            model: commentReplyModel,
            inputTokens: haikuRes.usage?.input_tokens,
            outputTokens: haikuRes.usage?.output_tokens,
            runtimeMs: Date.now() - haikuStart,
            leadId: batch.leadId,
            draftId: draft.id,
            metadata: { batch_size: batchMsgs.length },
            pricingOverrideRaw: resolvedCfg.get("AI_PRICING_OVERRIDES"),
          });
        } catch (replyErr) {
          // fail-open: la parte pública no sale pero el DM sigue.
          console.warn("generate-response: comment_reply generation failed (fail-open):", replyErr instanceof Error ? replyErr.message : String(replyErr));
        }
      }

      // El agente SIEMPRE genera borrador; el status decide si necesita aprobación:
      //  - forceReview (revisión humana explícita) → pending.
      //  - bypass (publica todo) → approved.
      //  - batch marcado requires_human_review (odio/queja/baja confianza) → pending.
      //  - vertical conversacional (auto_reply sin requires_review) → approved.
      //  - resto → pending.
      const batchNeedsReview = batchMsgs.some((m) => m.requires_human_review === true);
      // GUARDA: si el agente no emitió los tags <respuesta> el output es
      // malformado (meta-narración / alucinación de acciones). NUNCA se
      // auto-publica — va a revisión humana, sin importar bypass/auto_reply.
      const malformed = !outcome.hadRespuesta;
      const status = malformed
        ? "pending"
        : forceReview
        ? "pending"
        : bypass
        ? "approved"
        : batchNeedsReview
        ? "pending"
        : vertical.auto_reply && !vertical.requires_review
        ? "approved"
        : "pending";
      if (malformed) {
        console.warn(
          `generate-response: draft ${draft.id} sin tags <respuesta> (lead ${batch.leadId}) → revisión, no se auto-publica`
        );
      }

      await supabase
        .from("drafts")
        .update({
          body: outcome.responseText,
          status,
          agent_metadata: {
            session_id: outcome.sessionId,
            tool_calls: outcome.toolCalls,
            duration_ms: outcome.durationMs,
            model: resolvedCfg.getOr("AGENT_MODEL", "claude-sonnet-4-6"),
            vertical: vertical.slug,
            ...(malformed ? { malformed: true } : {}),
            ...(batchHasComment ? { from_comment: true } : {}),
            ...(publicReply ? { public_reply: publicReply } : {}),
          },
        })
        .eq("id", draft.id)
        // Solo si sigue pending: si el sweep lo borró (run dado por muerto) o
        // un humano lo resolvió mientras generábamos, no pisamos nada.
        .eq("status", "pending");

      // Captura fail-open de consumo CMA (helper compartido con follow-up-scan).
      await captureSessionUsage(supabase, {
        apiKey: resolvedCfg.require("ANTHROPIC_API_KEY"),
        sessionId: outcome.sessionId,
        component: "generate_response",
        model: resolvedCfg.getOr("AGENT_MODEL", "claude-sonnet-4-6"),
        leadId: batch.leadId,
        draftId: draft.id,
        fallbackRuntimeMs: outcome.durationMs,
        metadata: { vertical: vertical.slug, tool_calls: outcome.toolCalls },
        pricingOverrideRaw: resolvedCfg.get("AI_PRICING_OVERRIDES"),
      });

      if (status === "approved") {
        try {
          const pubRes = await fetch(`${SUPABASE_URL}/functions/v1/publish-to-kommo`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
          if (!pubRes.ok) console.warn("publish-to-kommo:", pubRes.status);
        } catch (e) {
          console.warn("publish-to-kommo failed:", e);
        }
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await supabase
        .from("drafts")
        .update({ status: "failed", agent_metadata: { error: errMsg } })
        .eq("id", draft.id)
        .eq("status", "pending");
      console.error("generate-response slowWork failed:", errMsg);
    }
  })();

  // @ts-ignore: EdgeRuntime existe en Supabase
  if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
    // @ts-ignore
    EdgeRuntime.waitUntil(slowWork);
  } else {
    // Fallback local (sin EdgeRuntime): esperar el trabajo.
    await slowWork;
  }

  return new Response(
    JSON.stringify({
      ok: true,
      draft_id: draft.id,
      message_id: latestMsg.id,
      batch_size: batchMsgs.length,
      accepted: true,
    }),
    { status: 202, headers: { "content-type": "application/json" } }
  );
});

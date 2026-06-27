// Edge Function: process-inbound
// Procesa eventos de inbound_queue:
//  1. Parsea payload de Kommo (leads.add, message.add)
//  2. Upsert leads (lead_id de Kommo)
//  3. Insert messages
//  4. Para incoming: clasifica con Haiku 4.5 según verticales en DB
//  5. Marca queue row como done
//
// Triggers: invocado por kommo-webhook (fire-and-forget) y por pg_cron (sweep).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import Anthropic from "npm:@anthropic-ai/sdk@0.95.1";
import { loadConfig } from "../_shared/config.ts";
import { recordUsage } from "../_shared/usage.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

const MAX_BATCH = 20;

// ---- Tipos del payload de Kommo ----
type KommoLead = {
  id: string | number;
  name?: string;
  pipeline_id?: string;
  status_id?: string;
  responsible_user_id?: string;
};
type KommoAttachment = {
  type?: string; // picture | photo | image | file | document | audio | voice | video
  link?: string;
  url?: string;
  file_name?: string;
  name?: string;
};
type KommoMessage = {
  id: string;
  text?: string;
  type: "incoming" | "outgoing";
  origin?: string; // "waba" | "instagram" | etc
  author?: { id: string; name?: string; type?: string };
  entity_id?: string;
  contact_id?: string;
  chat_id?: string;
  talk_id?: string | number;
  element_id?: string;
  entity_type?: string;
  created_at?: string;
  // Adjuntos (formato documentado de Kommo; parseo defensivo en extractMedia).
  attachment?: KommoAttachment;
  attachments?: KommoAttachment[];
};
type KommoPayload = {
  account?: { id?: string; subdomain?: string };
  leads?: { add?: KommoLead[]; update?: KommoLead[] };
  message?: { add?: KommoMessage[] };
};

// ---- Cache de verticales (refresh cada minuto) ----
type Vertical = {
  id: string;
  slug: string;
  description: string | null;
  requires_review: boolean;
  ignore: boolean;
};
let verticalsCache: { items: Vertical[]; loadedAt: number } | null = null;

async function getVerticals(): Promise<Vertical[]> {
  if (verticalsCache && Date.now() - verticalsCache.loadedAt < 60_000) {
    return verticalsCache.items;
  }
  const { data, error } = await supabase
    .from("verticals")
    .select("id, slug, description, requires_review, ignore")
    .order("slug");
  if (error) throw new Error(`fetch verticals: ${error.message}`);
  verticalsCache = { items: data ?? [], loadedAt: Date.now() };
  return verticalsCache.items;
}

// ---- Cache de reglas de silencio (menciones / palabras), refresh cada minuto ----
// Corren ANTES de Haiku: si un mensaje matchea una regla activa, el agente no
// responde y nos ahorramos el costo de clasificar. Las reglas se PRECOMPILAN al
// cargar el cache (no por mensaje): los RegExp se construyen una sola vez cada
// 60s, no en cada inbound.
type SkipRuleRow = {
  id: string;
  pattern: string;
  match_type: "contains" | "regex" | "mention_tag";
  case_sensitive: boolean;
};
type CompiledRule = { id: string; test: (text: string) => boolean };

function compileRule(rule: SkipRuleRow): CompiledRule {
  const { id, pattern, match_type, case_sensitive } = rule;
  if (match_type === "mention_tag") {
    // pattern vacío → cualquier @mención; pattern seteado → ese @handle puntual.
    // Una mención real lleva el @ al inicio o tras un espacio. En un email
    // ("correo: juliet@gmail.com") el @ va pegado al texto anterior — NO debe
    // matchear: silenciaba mensajes con datos de contacto del cliente.
    const handle = pattern.trim().replace(/^@/, "");
    if (!handle) {
      const re = /(^|\s)@\w+/;
      return { id, test: (t) => re.test(t) };
    }
    const escaped = handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    let re: RegExp;
    try {
      re = new RegExp(`(^|\\s)@${escaped}\\b`, case_sensitive ? "" : "i");
    } catch {
      return { id, test: () => false };
    }
    return { id, test: (t) => re.test(t) };
  }
  if (match_type === "regex") {
    // Regex inválida → nunca matchea (fail-safe, no rompe el pipeline).
    let re: RegExp | null = null;
    try {
      re = new RegExp(pattern, case_sensitive ? "" : "i");
    } catch {
      re = null;
    }
    return { id, test: (t) => (re ? re.test(t) : false) };
  }
  // contains (default): substring.
  const pat = pattern.trim();
  if (!pat) return { id, test: () => false };
  if (case_sensitive) return { id, test: (t) => t.includes(pat) };
  const lower = pat.toLowerCase();
  return { id, test: (t) => t.toLowerCase().includes(lower) };
}

let skipRulesCache: { items: CompiledRule[]; loadedAt: number } | null = null;

async function getSkipRules(): Promise<CompiledRule[]> {
  if (skipRulesCache && Date.now() - skipRulesCache.loadedAt < 60_000) {
    return skipRulesCache.items;
  }
  const { data, error } = await supabase
    .from("agent_skip_rules")
    .select("id, pattern, match_type, case_sensitive")
    .eq("enabled", true);
  if (error) {
    // La tabla puede no existir todavía (función desplegada antes de migrar).
    // Fail-open: sin reglas, el sistema se comporta como antes.
    console.warn("getSkipRules error — sin reglas:", error.message);
    skipRulesCache = { items: [], loadedAt: Date.now() };
    return skipRulesCache.items;
  }
  const items = ((data ?? []) as SkipRuleRow[]).map(compileRule);
  skipRulesCache = { items, loadedAt: Date.now() };
  return items;
}

function firstMatchingSkipRule(text: string, rules: CompiledRule[]): CompiledRule | null {
  for (const r of rules) {
    if (r.test(text)) return r;
  }
  return null;
}

// ---- Cache de filtros de publicación (canales + etapas), refresh cada minuto ----
// Canales: set en minúsculas (origin de Kommo o nombre legible). Etapas: set de
// status_id de Kommo. Ambos se evalúan ANTES de Haiku → una etapa/canal apagado
// no clasifica nada (cero tokens). Fail-open: si la columna no existe
// (pre-migración) o falla la lectura, los sets quedan vacíos.
type MediaFlags = { images: boolean; documents: boolean; audio: boolean };
type PublishFilters = {
  channels: Set<string>;
  stages: Set<number>;
  media: MediaFlags;
  agentOffFieldId: number | null;
  commentSourceIds: Set<number>;
};
let publishFiltersCache: (PublishFilters & { loadedAt: number }) | null = null;

async function getPublishFilters(): Promise<PublishFilters> {
  if (publishFiltersCache && Date.now() - publishFiltersCache.loadedAt < 60_000) {
    return publishFiltersCache;
  }
  const empty: MediaFlags = { images: false, documents: false, audio: false };
  const { data, error } = await supabase
    .from("kommo_publish_config")
    .select(
      "ignored_channels, ignored_stage_ids, respond_to_images, respond_to_documents, respond_to_audio, agent_off_field_id, comment_source_ids"
    )
    .eq("is_active", true)
    .maybeSingle();
  if (error) {
    console.warn("getPublishFilters error — sin filtros:", error.message);
    publishFiltersCache = {
      channels: new Set(),
      stages: new Set(),
      media: empty,
      agentOffFieldId: null,
      commentSourceIds: new Set(),
      loadedAt: Date.now(),
    };
    return publishFiltersCache;
  }
  const channels = new Set(
    ((data?.ignored_channels ?? []) as string[]).map((c) => c.toLowerCase())
  );
  const stages = new Set(((data?.ignored_stage_ids ?? []) as number[]).map(Number));
  const media: MediaFlags = {
    images: data?.respond_to_images === true,
    documents: data?.respond_to_documents === true,
    audio: data?.respond_to_audio === true,
  };
  const rawOff = data?.agent_off_field_id;
  const agentOffFieldId = rawOff != null && Number.isFinite(Number(rawOff)) ? Number(rawOff) : null;
  // Fail-open: columna ausente (pre-migración) → set vacío.
  const rawSrcIds = data?.comment_source_ids;
  const commentSourceIds = new Set<number>(
    Array.isArray(rawSrcIds) ? rawSrcIds.map(Number).filter((n: number) => Number.isFinite(n)) : []
  );
  publishFiltersCache = { channels, stages, media, agentOffFieldId, commentSourceIds, loadedAt: Date.now() };
  return publishFiltersCache;
}

// ---- Cache de source_id por talk_id (para detección de comentarios) ----
// Kommo no incluye source_id en el payload del webhook; hay que consultarlo
// via GET /api/v4/talks/{talk_id}. El resultado se cachea en module scope:
// un talk no cambia de fuente, por lo que no se necesita TTL.
// El mapa se limita a 500 entradas por FIFO simple para no crecer indefinidamente.
const TALK_CACHE_MAX = 500;
const talkSourceCache = new Map<number, number>(); // talk_id → source_id
const talkCacheOrder: number[] = []; // FIFO para el cap

async function getTalkSourceId(
  talkId: number,
  kommoDomain: string,
  kommoToken: string
): Promise<number | null> {
  if (talkSourceCache.has(talkId)) return talkSourceCache.get(talkId)!;
  try {
    const res = await fetch(`https://${kommoDomain}/api/v4/talks/${talkId}`, {
      headers: { Authorization: `Bearer ${kommoToken}` },
    });
    if (!res.ok) return null;
    // deno-lint-ignore no-explicit-any
    const j = (await res.json()) as any;
    const sourceId = j?.source_id != null ? Number(j.source_id) : null;
    if (sourceId != null && Number.isFinite(sourceId)) {
      // FIFO cap
      if (talkCacheOrder.length >= TALK_CACHE_MAX) {
        const evict = talkCacheOrder.shift();
        if (evict !== undefined) talkSourceCache.delete(evict);
      }
      talkSourceCache.set(talkId, sourceId);
      talkCacheOrder.push(talkId);
      return sourceId;
    }
    return null;
  } catch (err) {
    // Fail-open: un error del GET no afecta el pipeline; sin marca = DM (comportamiento actual).
    console.warn(`getTalkSourceId ${talkId}:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

// ---- "Apagar Agente": lee el campo interruptor del lead en Kommo ----
function isTruthyKommoValue(v: unknown): boolean {
  if (v === true || v === 1) return true;
  const s = String(v ?? "").trim().toLowerCase();
  return ["1", "true", "on", "yes", "si", "sí", "y", "activo"].includes(s);
}

// deno-lint-ignore no-explicit-any
async function isAgentOffForLead(
  kommoLeadId: number,
  fieldId: number,
  domain: string,
  token: string
): Promise<boolean> {
  try {
    const res = await fetch(`https://${domain}/api/v4/leads/${kommoLeadId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return false; // fail-open: si no se puede leer, el agente responde normal
    // deno-lint-ignore no-explicit-any
    const lead = (await res.json()) as any;
    const cfv = (lead?.custom_fields_values ?? []) as Array<{
      field_id: number;
      values: Array<{ value: unknown }>;
    }>;
    const f = cfv.find((c) => Number(c.field_id) === Number(fieldId));
    if (!f) return false;
    return isTruthyKommoValue(f.values?.[0]?.value);
  } catch {
    return false;
  }
}

// ---- Mapea origin de Kommo a un canal "legible" ----
function originToChannel(origin?: string): string {
  if (!origin) return "unknown";
  if (origin === "waba" || origin.includes("whatsapp")) return "whatsapp";
  if (origin.includes("instagram")) return "instagram_dm";
  if (origin.includes("telegram")) return "telegram";
  if (origin.includes("facebook")) return "facebook";
  return origin;
}

// ---- Adjuntos (media) ----
// kind: image (visión) | document (PDF, document block) | audio (aún no, sin STT)
//       | other (no procesable nativamente: docx/xls/etc).
// PARSEO DEFENSIVO contra el formato documentado de Kommo — se valida con un
// payload real. Si la forma difiere, devuelve null (degrada a texto/sin media).
type ExtractedMedia = {
  kind: "image" | "document" | "audio" | "other";
  label: string;
  source: { type: "url"; url: string };
  filename?: string;
};
type MediaForClassify = {
  kind: "image" | "document";
  label: string;
  source: { type: "url"; url: string };
};

function extractMedia(m: KommoMessage): ExtractedMedia | null {
  const att = m.attachment ?? (Array.isArray(m.attachments) ? m.attachments[0] : undefined);
  if (!att) return null;
  const url = (att.link ?? att.url ?? "").trim();
  if (!url || !/^https?:\/\//i.test(url)) return null;
  const filename = att.file_name ?? att.name ?? undefined;
  const t = (att.type ?? "").toLowerCase();
  const ext = (filename ?? url).toLowerCase().split("?")[0].split(".").pop() ?? "";

  const isImg =
    ["picture", "photo", "image"].some((k) => t.includes(k)) ||
    ["jpg", "jpeg", "png", "gif", "webp"].includes(ext);
  const isPdf = t.includes("pdf") || ext === "pdf";
  const isAudio =
    ["audio", "voice"].some((k) => t.includes(k)) ||
    ["mp3", "ogg", "opus", "wav", "m4a", "amr"].includes(ext);
  const isDoc =
    ["file", "document"].some((k) => t.includes(k)) ||
    ["doc", "docx", "xls", "xlsx", "txt", "csv"].includes(ext);

  if (isImg) return { kind: "image", label: "Imagen", source: { type: "url", url }, filename };
  if (isPdf) return { kind: "document", label: "Documento", source: { type: "url", url }, filename };
  if (isAudio) return { kind: "audio", label: "Audio", source: { type: "url", url }, filename };
  // docx/xls/etc.: Claude no los lee nativamente (solo PDF) → no procesable aún.
  if (isDoc) return { kind: "other", label: "Archivo", source: { type: "url", url }, filename };
  return { kind: "other", label: "Archivo", source: { type: "url", url }, filename };
}

// ---- Upsert lead ----
// inbound: true → actualiza last_inbound_at (reloj de inactividad para seguimiento)
// stageId: número → actualiza kommo_stage_id (para run_stage_ids de follow-up)
async function upsertLead(
  kommoLeadId: number,
  opts: { name?: string; channel?: string; contactId?: number; inbound?: boolean; stageId?: number }
) {
  const update: Record<string, unknown> = {
    last_message_at: new Date().toISOString(),
  };
  if (opts.name) update.display_name = opts.name;
  if (opts.channel) update.channel = opts.channel;
  if (opts.contactId) update.kommo_contact_id = opts.contactId;
  // Hook de seguimiento: reloj de inactividad (solo inbound)
  if (opts.inbound) update.last_inbound_at = new Date().toISOString();
  // Hook de seguimiento: sincronizar etapa de Kommo
  if (opts.stageId !== undefined && opts.stageId !== null) update.kommo_stage_id = opts.stageId;

  // Buscar existente
  const { data: existing } = await supabase
    .from("leads")
    .select("id, follow_up_status, kommo_stage_id")
    .eq("kommo_lead_id", kommoLeadId)
    .maybeSingle();

  if (existing) {
    await supabase.from("leads").update(update).eq("id", existing.id);
    // Hook de seguimiento: si llegó un inbound y la secuencia está activa → responded
    if (opts.inbound && (existing as { follow_up_status?: string }).follow_up_status === "active") {
      await supabase
        .from("leads")
        .update({ follow_up_status: "responded" })
        .eq("id", existing.id);
    }
    // Capturar movimiento de etapa externo (Kommo): solo cuando cambia el valor
    // y el anterior no era null (null→id = lead nuevo con etapa inicial, no un movimiento).
    const prevStageId = (existing as { kommo_stage_id?: number | null }).kommo_stage_id;
    const newStageId = opts.stageId;
    if (
      newStageId !== undefined &&
      newStageId !== null &&
      prevStageId !== undefined &&
      prevStageId !== null &&
      Number(prevStageId) !== Number(newStageId)
    ) {
      try {
        await supabase.from("lead_stage_events").insert({
          lead_id: existing.id,
          from_stage_id: Number(prevStageId),
          to_stage_id: Number(newStageId),
          from_stage_name: null, // sin nombres — el UI los resuelve vía mapa de stages
          to_stage_name: null,
          pipeline_name: null,
          moved_by: "kommo",
          draft_id: null,
        });
      } catch (evErr) {
        console.warn("lead_stage_events insert (kommo) — fail-open:", evErr instanceof Error ? evErr.message : String(evErr));
      }
    }
    return existing.id as string;
  }
  const { data: inserted, error } = await supabase
    .from("leads")
    .insert({
      kommo_lead_id: kommoLeadId,
      kommo_contact_id: opts.contactId ?? null,
      channel: opts.channel ?? null,
      display_name: opts.name ?? null,
      last_message_at: update.last_message_at,
      last_inbound_at: opts.inbound ? update.last_inbound_at : null,
      kommo_stage_id: opts.stageId ?? null,
    })
    .select("id")
    .single();
  if (error || !inserted) throw new Error(`upsert lead: ${error?.message}`);
  return inserted.id as string;
}

// ---- Clasificación con Haiku ----
type Classification = {
  vertical_slug: string;
  intent: "info" | "purchase" | "support" | "feedback" | "spam" | "other";
  urgency: number; // 1..5
  toxicity: number; // 0..1
  requires_human_review: boolean;
  confidence: number;
  reasoning: string;
  inferred_gender: "masculino" | "femenino" | "desconocido"; // del NOMBRE del lead
  mentioned_age: number; // años si el lead los menciona; 0 si no
};

async function classify(
  text: string,
  channel: string,
  verticals: Vertical[],
  anthropic: Anthropic,
  operator: string,
  model: string,
  media?: MediaForClassify | null,
  leadName?: string
): Promise<Classification & { media_summary?: string; __usage?: Anthropic.Usage }> {
  const verticalList = verticals
    .map((v) => `  - ${v.slug}: ${v.description ?? "(sin descripción)"}`)
    .join("\n");
  const system = `Eres un clasificador de mensajes entrantes para ${operator}.

Recibes mensajes desde Instagram DM, comentarios de Instagram, WhatsApp y formularios web. Pueden incluir un adjunto (imagen o documento). Tu único trabajo es asignar exactamente una vertical, dar señales numéricas y, si hay adjunto, describirlo.

Verticales disponibles:
${verticalList}

Reglas:
- Si el mensaje es ambiguo o no encaja claramente en ninguna vertical específica, usa "general". El agente le hará una pregunta clarificadora. NO marques requires_human_review por ser ambiguo.
- Solo marca requires_human_review=true cuando: (a) sea hate/sarcasmo/troll/insulto, (b) sea una queja seria que requiera intervención humana, o (c) tu confidence sea < 0.4.
- media_summary: si hay un adjunto (imagen/documento), describí en 1-3 frases QUÉ muestra y transcribí el texto/datos visibles relevantes (precios, números, nombres). Si no hay adjunto, devolvé "".
- Usá la descripción de cada vertical (arriba) para decidir el slug correcto. No inventes verticales que no estén en la lista.
- intent: info (consulta abierta), purchase (intención de compra clara), support (problema con algo ya comprado), feedback, spam, other.
- urgency: 1 (casual) a 5 (urgente — cliente molesto, urgencia explícita).
- toxicity: 0 (neutro/positivo) a 1 (insulto directo).
- confidence: qué tan seguro estás de la vertical asignada.
- reasoning: 1-2 frases en español neutro explicando por qué.
- inferred_gender: inferí el género probable de la persona SOLO a partir de su NOMBRE${leadName ? ` (el nombre del lead es: "${leadName}")` : " (no hay nombre disponible en este caso)"}. Devolvé "masculino" o "femenino" únicamente si el nombre lo indica con claridad; si es unisex, ambiguo, un nombre de empresa, un nombre extranjero poco común, o no hay nombre → "desconocido". NUNCA lo deduzcas del contenido del mensaje, solo del nombre.
- mentioned_age: si el lead MENCIONA EXPLÍCITAMENTE su edad en el mensaje (ej: "tengo 62 años", "soy una señora de la tercera edad" → estimá, "ya estoy jubilado" → 0 si no hay número), devolvé el número de años. Si no menciona edad, devolvé 0. No inventes ni estimes a partir del estilo de escritura.`;

  // Contenido del turno: texto, o bloque de media + texto cuando hay adjunto.
  // deno-lint-ignore no-explicit-any
  let userContent: any;
  if (media) {
    // deno-lint-ignore no-explicit-any
    const blocks: any[] = [];
    if (media.kind === "image") blocks.push({ type: "image", source: media.source });
    else blocks.push({ type: "document", source: media.source });
    blocks.push({
      type: "text",
      text: `Canal: ${channel}\n\nEl lead envió un adjunto (${media.label}).${
        text ? ` Texto del lead:\n"""${text}"""` : " (sin texto, ver el adjunto)"
      }`,
    });
    userContent = blocks;
  } else {
    userContent = `Canal: ${channel}\n\nMensaje:\n"""${text}"""`;
  }

  const response = await anthropic.messages.create({
    model,
    max_tokens: 1024,
    system,
    messages: [{ role: "user", content: userContent }],
    output_config: {
      format: {
        type: "json_schema",
        schema: {
          type: "object",
          additionalProperties: false,
          properties: {
            vertical_slug: { type: "string", enum: verticals.map((v) => v.slug) },
            intent: {
              type: "string",
              enum: ["info", "purchase", "support", "feedback", "spam", "other"],
            },
            urgency: { type: "integer" },
            toxicity: { type: "number" },
            requires_human_review: { type: "boolean" },
            confidence: { type: "number" },
            reasoning: { type: "string" },
            media_summary: { type: "string" },
            inferred_gender: { type: "string", enum: ["masculino", "femenino", "desconocido"] },
            mentioned_age: { type: "integer" },
          },
          required: [
            "vertical_slug",
            "intent",
            "urgency",
            "toxicity",
            "requires_human_review",
            "confidence",
            "reasoning",
            "media_summary",
            "inferred_gender",
            "mentioned_age",
          ],
        },
      },
    },
  });

  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error("classify: no text block in response");
  const parsed = JSON.parse(block.text) as Classification & { media_summary?: string; __usage?: Anthropic.Usage };
  // Clamp en código (los structured outputs no soportan min/max)
  parsed.urgency = Math.max(1, Math.min(5, Math.round(parsed.urgency ?? 1)));
  parsed.toxicity = Math.max(0, Math.min(1, parsed.toxicity ?? 0));
  parsed.confidence = Math.max(0, Math.min(1, parsed.confidence ?? 0));
  // Normaliza demografía (structured outputs no soportan defaults/min/max).
  if (parsed.inferred_gender !== "masculino" && parsed.inferred_gender !== "femenino") {
    parsed.inferred_gender = "desconocido";
  }
  parsed.mentioned_age = Math.max(0, Math.round(parsed.mentioned_age ?? 0));
  parsed.__usage = response.usage;
  return parsed;
}

// Persiste género (inferido del nombre, una sola vez) y edad (cuando el lead la
// menciona) en el lead, para que generate-response los inyecte al contexto.
async function storeLeadDemographics(
  leadId: string,
  cls: Pick<Classification, "inferred_gender" | "mentioned_age">
): Promise<void> {
  try {
    if (cls.inferred_gender === "masculino" || cls.inferred_gender === "femenino") {
      // is('gender', null) → solo lo setea la primera vez; no pisa correcciones.
      await supabase.from("leads").update({ gender: cls.inferred_gender }).eq("id", leadId).is("gender", null);
    }
    const age = Math.round(cls.mentioned_age ?? 0);
    if (age > 0 && age < 120) {
      const band = age >= 55 ? "mayor" : age >= 25 ? "adulto" : "joven";
      await supabase.from("leads").update({ age, age_band: band }).eq("id", leadId);
    }
  } catch (e) {
    console.error("storeLeadDemographics:", e instanceof Error ? e.message : String(e));
  }
}

// ---- Transcripción de audio (OpenAI Whisper) ----
// Descarga la nota de voz y la transcribe. Devuelve null si el resultado
// viene vacío; tira en cualquier falla (download, tamaño, API).
const MAX_AUDIO_BYTES = 24_000_000; // límite de Whisper ~25MB

// Anti-SSRF: el webhook entra SIN autenticación (verify_jwt=false), así que
// la URL del adjunto es input hostil — sin esto, un payload forjado haría que
// la función fetchee direcciones internas. Solo https hacia los dominios de
// media de Kommo/amoCRM (verificados en payloads reales: amojo.kommo.com,
// <subdominio>.amocrm.com). URL fuera del allowlist → falla → human review.
const AUDIO_HOST_SUFFIXES = [".kommo.com", ".amocrm.com", ".amocrm.ru", ".amojo.me"];
// Hosts permitidos como DESTINO de un redirect (no como URL inicial). Kommo
// sirve el adjunto desde amojo/drive-c.kommo.com con un 301 final hacia Google
// Cloud Storage (storage.googleapis.com), donde está el archivo real. Es un
// host PÚBLICO de Google (jamás resuelve a una IP interna), seguro como destino
// de redirect — pero NO lo aceptamos como URL inicial del webhook.
const AUDIO_REDIRECT_HOST_SUFFIXES = [...AUDIO_HOST_SUFFIXES, ".googleapis.com"];

function assertAllowedAudioUrl(raw: string, suffixes: string[] = AUDIO_HOST_SUFFIXES): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("audio url inválida");
  }
  if (u.protocol !== "https:") throw new Error("audio url no-https");
  const host = u.hostname.toLowerCase().replace(/\.$/, "");
  // Nunca IPs literales (v4 o v6) — solo hostnames de los dominios esperados.
  if (/^[\d.]+$/.test(host) || host.includes(":")) throw new Error("audio host no permitido");
  if (!suffixes.some((s) => host.endsWith(s) || host === s.slice(1))) {
    throw new Error(`audio host no permitido: ${host}`);
  }
  return u;
}

// Extensiones de audio que Whisper acepta. Whisper detecta el formato por la
// EXTENSIÓN del filename, no por el contenido — y Kommo miente: el adjunto se
// llama file.ogg pero el contenido real suele ser audio/mp4 (m4a). Si le
// pasamos la extensión equivocada, Whisper devuelve 400 "Invalid file format".
const WHISPER_EXT_RE = /\.(flac|m4a|mp3|mp4|mpeg|mpga|oga|ogg|wav|webm)$/i;

// Content-Type real → extensión que Whisper entiende. Es la fuente AUTORITATIVA
// (más confiable que el nombre del archivo o el path de la URL).
const CONTENT_TYPE_EXT: Record<string, string> = {
  "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/m4a": "m4a", "audio/aac": "m4a",
  "audio/mpeg": "mp3", "audio/mp3": "mp3",
  "audio/ogg": "ogg", "audio/opus": "ogg", "application/ogg": "ogg",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
  "audio/webm": "webm", "video/webm": "webm",
  "audio/flac": "flac", "audio/x-flac": "flac",
};

function audioFilename(contentType: string | null, finalUrl: URL, fallback?: string): string {
  // 1) Content-Type real (autoritativo).
  const ct = (contentType ?? "").split(";")[0].trim().toLowerCase();
  if (CONTENT_TYPE_EXT[ct]) return `audio.${CONTENT_TYPE_EXT[ct]}`;
  // 2) Extensión del path de la URL final, si es una soportada.
  const base = finalUrl.pathname.split("/").pop() ?? "";
  if (WHISPER_EXT_RE.test(base)) return base;
  // 3) Nombre que dio Kommo (poco confiable), y por último m4a (el formato más común).
  if (fallback && WHISPER_EXT_RE.test(fallback)) return fallback;
  return "audio.m4a";
}

async function transcribeAudio(
  openaiKey: string,
  url: string,
  filename?: string
): Promise<string | null> {
  const safeUrl = assertAllowedAudioUrl(url);
  // Kommo sirve el adjunto desde amojo.kommo.com con un 301 hacia
  // drive-c.kommo.com. Necesitamos seguir ese redirect:
  //  - redirect:"error"  → tiraba ante el 301 (ninguna nota de voz se transcribía).
  //  - redirect:"manual" → en Deno devuelve una respuesta opaca (status 0, sin
  //    headers), así que NO se puede leer el Location para seguirlo a mano.
  //  - redirect:"follow" → Deno sigue el 301 solo. Es la única que funciona acá.
  // Anti-SSRF: la URL inicial ya está en el allowlist y Kommo solo redirige a su
  // propio storage; revalidamos además el host FINAL (res.url) post-hoc.
  const audioRes = await fetch(safeUrl, { redirect: "follow" });
  if (!audioRes.ok) throw new Error(`audio download ${audioRes.status}`);
  // El host FINAL puede ser Kommo o Google Storage (destino legítimo del 301).
  const finalUrl = assertAllowedAudioUrl(audioRes.url || safeUrl.toString(), AUDIO_REDIRECT_HOST_SUFFIXES);
  const blob = await audioRes.blob();
  if (blob.size === 0) throw new Error("audio vacío");
  if (blob.size > MAX_AUDIO_BYTES) throw new Error(`audio demasiado grande (${blob.size} bytes)`);

  const form = new FormData();
  form.append("file", blob, audioFilename(audioRes.headers.get("content-type"), finalUrl, filename));
  form.append("model", "whisper-1");
  const res = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}` },
    body: form,
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`whisper ${res.status}: ${detail.slice(0, 200)}`);
  }
  const j = (await res.json()) as { text?: unknown };
  const text = typeof j.text === "string" ? j.text.trim() : "";
  return text || null;
}

// ---- Procesa un payload completo ----
async function processPayload(payload: KommoPayload, anthropic: Anthropic, operator: string) {
  const subdomain = payload.account?.subdomain ?? null;
  const inboundMessageIds: string[] = [];
  const verticals = await getVerticals();
  const verticalsBySlug = new Map(verticals.map((v) => [v.slug, v]));
  const skipRules = await getSkipRules();
  const filters = await getPublishFilters();
  // Creds de Kommo (DB-first, cache 60s) para el gate "Apagar Agente".
  const runtimeCfg = await loadConfig(supabase);
  // Modelo del clasificador: editable desde /consumo (DB-first, fallback Haiku).
  const classifyModel = runtimeCfg.getOr("CLASSIFY_MODEL", "claude-haiku-4-5");
  const kommoDomain = runtimeCfg.get("KOMMO_API_DOMAIN");
  const kommoToken = runtimeCfg.get("KOMMO_ACCESS_TOKEN");
  // Key de OpenAI para transcribir notas de voz (Whisper). Sin key, los
  // audios se ignoran con razón explícita aunque el toggle esté prendido.
  const openaiKey = runtimeCfg.get("OPENAI_API_KEY");

  // 1) Upsert leads de leads.add
  if (payload.leads?.add) {
    for (const l of payload.leads.add) {
      const id = Number(l.id);
      if (!Number.isFinite(id)) continue;
      const stageId = l.status_id ? Number(l.status_id) : undefined;
      await upsertLead(id, {
        name: l.name,
        stageId: Number.isFinite(stageId) ? stageId : undefined,
      });
    }
  }

  // 2) Procesar messages
  if (payload.message?.add) {
    for (const m of payload.message.add) {
      const leadKommoId = Number(m.entity_id ?? m.element_id);
      if (!Number.isFinite(leadKommoId)) continue;

      const channel = originToChannel(m.origin);
      const isInbound = m.type === "incoming";
      // status_id en el payload se usa para actualizar la etapa del lead en Kommo
      const stageId = payload.leads?.add?.[0]?.status_id
        ? Number(payload.leads.add[0].status_id)
        : undefined;
      const leadId = await upsertLead(leadKommoId, {
        name: isInbound ? m.author?.name : undefined,
        channel,
        contactId: m.contact_id ? Number(m.contact_id) : undefined,
        inbound: isInbound,
        stageId: stageId !== undefined && Number.isFinite(stageId) ? stageId : undefined,
      });

      const direction = m.type === "incoming" ? "inbound" : "outbound";
      let text = (m.text ?? "").trim();
      const media = extractMedia(m);
      // Mensaje realmente vacío (ni texto ni adjunto) → nada que hacer.
      if (!text && !media) continue;

      // ¿El adjunto es procesable y está habilitado?
      let mediaForClassify: MediaForClassify | null = null;
      let mediaIgnoreReason: string | null = null;
      if (media) {
        if (media.kind === "image") {
          if (filters.media.images)
            mediaForClassify = { kind: "image", label: media.label, source: media.source };
          else mediaIgnoreReason = "media_image_off";
        } else if (media.kind === "document") {
          if (filters.media.documents)
            mediaForClassify = { kind: "document", label: media.label, source: media.source };
          else mediaIgnoreReason = "media_document_off";
        } else if (media.kind === "audio") {
          // Nota de voz → transcripción con Whisper si el toggle está prendido
          // y hay key de OpenAI. El texto transcrito sigue el camino normal
          // (clasificación + respuesta) como si el lead lo hubiera tecleado.
          if (!filters.media.audio) {
            mediaIgnoreReason = "media_audio_off";
          } else if (!openaiKey) {
            mediaIgnoreReason = "media_audio_no_key";
          } else if (isInbound && media.source.type === "url") {
            try {
              const transcript = await transcribeAudio(openaiKey, media.source.url, media.filename);
              if (transcript) {
                text = text ? `${text}\n🎙️ ${transcript}` : `🎙️ ${transcript}`;
              } else {
                mediaIgnoreReason = "media_audio_transcribe_failed";
              }
            } catch (err) {
              console.error("whisper:", err instanceof Error ? err.message : String(err));
              mediaIgnoreReason = "media_audio_transcribe_failed";
            }
          } else {
            mediaIgnoreReason = "media_audio_unsupported";
          }
        } else {
          mediaIgnoreReason = "media_unsupported";
        }
      }

      // Contenido inicial: texto, o un placeholder si es media-only (se reemplaza
      // por la descripción de Haiku tras clasificar, si el adjunto se procesa).
      const baseContent =
        text || (media ? `[${media.label}${media.filename ? ` ${media.filename}` : ""}]` : "");

      // Insert message (sin classification al principio)
      const { data: msg, error: msgErr } = await supabase
        .from("messages")
        .insert({
          lead_id: leadId,
          direction,
          source: channel,
          content: baseContent,
          kommo_message_id: m.id,
          media_url: media?.source.url ?? null,
          media_kind: media?.kind ?? null,
        })
        .select("id")
        .single();
      if (msgErr || !msg) {
        console.error("insert message:", msgErr);
        continue;
      }

      // Detección de comentario de Instagram: si el mensaje tiene talk_id y
      // hay comment_source_ids configurados, consultamos el talk en Kommo para
      // ver si su source_id pertenece al set de fuentes de comentarios.
      // Fail-open: un fallo del GET no afecta el pipeline; sin marca = DM.
      if (isInbound && filters.commentSourceIds.size > 0 && m.talk_id != null) {
        const talkId = Number(m.talk_id);
        if (Number.isFinite(talkId) && kommoDomain && kommoToken) {
          const sourceId = await getTalkSourceId(talkId, kommoDomain, kommoToken);
          if (sourceId !== null && filters.commentSourceIds.has(sourceId)) {
            await supabase.from("messages").update({ is_comment: true }).eq("id", msg.id);
          }
        }
      }

      // Clasificar solo inbound
      if (direction !== "inbound") continue;

      // Apagar Agente: si el campo interruptor del lead está encendido en Kommo,
      // el agente NO responde a ese lead (la asesora tomó el caso). Es lo primero
      // que chequeamos: corta todo antes de gastar nada.
      if (filters.agentOffFieldId && kommoDomain && kommoToken) {
        const off = await isAgentOffForLead(
          leadKommoId,
          filters.agentOffFieldId,
          kommoDomain,
          kommoToken
        );
        if (off) {
          await supabase
            .from("messages")
            .update({ ignored: true, ignored_reason: "agent_off" })
            .eq("id", msg.id);
          continue;
        }
      }

      // Canal ignorado: si el mensaje llega por un canal silenciado, el agente
      // no responde. Matchea tanto el canal legible (originToChannel) como el
      // origin crudo de Kommo, para que sirva elijas el que elijas.
      if (filters.channels.size > 0) {
        const originLc = (m.origin ?? "").toLowerCase();
        if (filters.channels.has(channel) || (originLc && filters.channels.has(originLc))) {
          await supabase
            .from("messages")
            .update({ ignored: true, ignored_reason: `channel:${channel}` })
            .eq("id", msg.id);
          continue;
        }
      }

      // Etapa ignorada: si el lead está en una etapa apagada, NO clasificamos
      // (cero tokens). El gate de generate-response queda igual como red de
      // seguridad por si el lead cambia de etapa entre el inbound y la respuesta.
      if (filters.stages.size > 0) {
        const { data: ld } = await supabase
          .from("leads")
          .select("kommo_stage_id")
          .eq("id", leadId)
          .maybeSingle();
        const st = ld?.kommo_stage_id;
        if (st != null && filters.stages.has(Number(st))) {
          await supabase
            .from("messages")
            .update({ ignored: true, ignored_reason: `stage:${st}` })
            .eq("id", msg.id);
          continue;
        }
      }

      // Reglas de silencio (menciones / @etiquetas / palabras): si el texto
      // matchea una regla activa, el agente NO responde. Marcamos ignored y NO
      // clasificamos (ahorra el costo de Haiku). No se dispara generate-response.
      const skipHit = firstMatchingSkipRule(text, skipRules);
      if (skipHit) {
        await supabase
          .from("messages")
          .update({ ignored: true, ignored_reason: `rule:${skipHit.id}` })
          .eq("id", msg.id);
        continue;
      }

      // Audio habilitado cuya transcripción falló → revisión humana (alguien
      // tiene que escucharlo), no ignorar en silencio.
      if (!text && mediaIgnoreReason === "media_audio_transcribe_failed") {
        await supabase
          .from("messages")
          .update({ requires_human_review: true, classification: { error: "audio_transcribe_failed" } })
          .eq("id", msg.id);
        continue;
      }

      // Media sin texto que NO se puede/quiere procesar (toggle apagado, audio
      // sin STT, o tipo no soportado) → el agente no responde. No clasificamos.
      if (!text && media && !mediaForClassify) {
        await supabase
          .from("messages")
          .update({ ignored: true, ignored_reason: mediaIgnoreReason ?? "media_off" })
          .eq("id", msg.id);
        continue;
      }

      try {
        const leadName = isInbound ? (m.author?.name ?? undefined) : undefined;
        const cls = await classify(text, channel, verticals, anthropic, operator, classifyModel, mediaForClassify, leadName);
        const v = verticalsBySlug.get(cls.vertical_slug);
        // Género (del nombre) + edad (si la mencionó) → al lead para el contexto.
        await storeLeadDemographics(leadId, cls);
        // Si clasificamos un adjunto, guardamos su descripción como contenido del
        // mensaje, así el agente (y el inbox) tienen texto con qué trabajar.
        const extra: Record<string, unknown> = {};
        if (mediaForClassify && cls.media_summary && cls.media_summary.trim()) {
          const desc = `[${mediaForClassify.label}] ${cls.media_summary.trim()}`;
          extra.content = text ? `${text}\n${desc}` : desc;
        }
        // Vertical marcada "ignorar": guardamos clasificación (para registro y
        // analytics) pero el agente no responde ni manda a revisión humana.
        if (v?.ignore) {
          await supabase
            .from("messages")
            .update({
              ...extra,
              vertical_id: v.id,
              classification: cls,
              ignored: true,
              ignored_reason: `vertical:${v.slug}`,
            })
            .eq("id", msg.id);
          // Captura fail-open de consumo classify (vertical ignorada)
          await recordUsage(supabase, {
            component: "classify", model: classifyModel,
            inputTokens: cls.__usage?.input_tokens,
            outputTokens: cls.__usage?.output_tokens,
            cacheReadTokens: cls.__usage?.cache_read_input_tokens,
            // deno-lint-ignore no-explicit-any
            cacheCreation5m: (cls.__usage as any)?.cache_creation?.ephemeral_5m_input_tokens,
            leadId: leadId,
            metadata: { vertical: cls.vertical_slug, msg_id: msg.id },
            pricingOverrideRaw: runtimeCfg.get("AI_PRICING_OVERRIDES"),
          });
          continue;
        }
        const needsReview = cls.requires_human_review || (v?.requires_review ?? false);
        await supabase
          .from("messages")
          .update({
            ...extra,
            vertical_id: v?.id ?? null,
            classification: cls,
            requires_human_review: needsReview,
          })
          .eq("id", msg.id);
        if (!needsReview && v?.id) inboundMessageIds.push(msg.id);
        // Captura fail-open de consumo classify
        await recordUsage(supabase, {
          component: "classify", model: classifyModel,
          inputTokens: cls.__usage?.input_tokens,
          outputTokens: cls.__usage?.output_tokens,
          cacheReadTokens: cls.__usage?.cache_read_input_tokens,
          // deno-lint-ignore no-explicit-any
          cacheCreation5m: (cls.__usage as any)?.cache_creation?.ephemeral_5m_input_tokens,
          leadId: leadId,
          metadata: { vertical: cls.vertical_slug, msg_id: msg.id },
          pricingOverrideRaw: runtimeCfg.get("AI_PRICING_OVERRIDES"),
        });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        // Si era un adjunto sin texto y la clasificación falló (p.ej. la URL no
        // es accesible), lo mandamos a revisión humana en vez de descartarlo.
        await supabase
          .from("messages")
          .update({
            classification: { error: errMsg },
            ...(mediaForClassify && !text ? { requires_human_review: true } : {}),
          })
          .eq("id", msg.id);
        console.error("classify failed:", errMsg);
      }
    }
  }

  return {
    subdomain,
    leads_processed: payload.leads?.add?.length ?? 0,
    messages_processed: payload.message?.add?.length ?? 0,
    inboundMessageIds,
  };
}

// ---- Recuperación de clasificaciones fallidas ----
// Una falla transitoria (sin créditos, API caída) dejaba mensajes con
// classification.error y vertical NULL → invisibles para la cola PARA SIEMPRE.
// El cron pasa cada minuto: reintentamos hasta 10 por ciclo. Adjuntos con URL
// persistida (0035) se re-clasifican con imagen; sin URL → revisión humana.
const RECOVER_BATCH = 10;

async function recoverFailedClassifications(
  anthropic: Anthropic,
  operator: string,
  opts: { leadIds?: string[]; limit?: number; newestFirst?: boolean } = {}
): Promise<number> {
  try {
    let q = supabase
      .from("messages")
      .select("id, lead_id, content, source, media_url, media_kind, classification, leads(display_name)")
      .eq("direction", "inbound")
      .eq("ignored", false)
      .is("vertical_id", null)
      .not("classification->error", "is", null)
      .not("classification->>error", "like", "recover:%");
    if (opts.leadIds && opts.leadIds.length) q = q.in("lead_id", opts.leadIds);
    q = q.order("created_at", { ascending: !opts.newestFirst }).limit(opts.limit ?? RECOVER_BATCH);
    const { data: rows } = await q;
    if (!rows || rows.length === 0) return 0;

    const runtimeCfg = await loadConfig(supabase);
    const classifyModel = runtimeCfg.getOr("CLASSIFY_MODEL", "claude-haiku-4-5");
    const verticals = await getVerticals();
    const verticalsBySlug = new Map(verticals.map((v) => [v.slug, v]));
    // Para reintentar la transcripción de notas de voz que fallaron de forma
    // transitoria (redirect, OpenAI caído) en vez de dejarlas en revisión.
    const openaiKey = runtimeCfg.get("OPENAI_API_KEY");
    const filters = await getPublishFilters();
    let healed = 0;

    for (const msg of rows) {
      const isPlaceholder = /^\[(Imagen|Documento|Audio|Archivo)/.test(msg.content ?? "");
      let mediaForClassify: MediaForClassify | null = null;
      // Si recuperamos una nota de voz por transcripción, este es el texto que
      // sigue el flujo normal (clasificación) y reemplaza el placeholder.
      let recoveredText: string | null = null;
      if (isPlaceholder) {
        if (msg.media_url && (msg.media_kind === "image" || msg.media_kind === "document")) {
          mediaForClassify = {
            kind: msg.media_kind as "image" | "document",
            label: msg.media_kind === "image" ? "Imagen" : "Documento",
            source: { type: "url", url: msg.media_url },
          };
        } else if (msg.media_url && msg.media_kind === "audio") {
          // Nota de voz: reintentar transcripción. Sin key o toggle apagado →
          // revisión humana (alguien la escucha).
          if (!openaiKey || !filters.media.audio) {
            await supabase
              .from("messages")
              .update({ requires_human_review: true, classification: { error: "recover: audio sin transcripción (toggle/key)" } })
              .eq("id", msg.id);
            continue;
          }
          try {
            const transcript = await transcribeAudio(openaiKey, msg.media_url, msg.content?.match(/\[Audio ([^\]]+)\]/)?.[1]);
            if (!transcript) {
              await supabase
                .from("messages")
                .update({ requires_human_review: true, classification: { error: "recover: audio transcripción vacía" } })
                .eq("id", msg.id);
              continue;
            }
            recoveredText = `🎙️ ${transcript}`;
          } catch (err) {
            console.error("recover whisper:", err instanceof Error ? err.message : String(err));
            await supabase
              .from("messages")
              .update({ requires_human_review: true, classification: { error: "recover: audio transcribe failed" } })
              .eq("id", msg.id);
            continue;
          }
        } else {
          // Adjunto irrecuperable (sin URL o tipo no procesable) → que lo vea un humano.
          await supabase
            .from("messages")
            .update({ requires_human_review: true, classification: { error: "recover: adjunto sin URL procesable" } })
            .eq("id", msg.id);
          continue;
        }
      }
      const text = recoveredText ?? (isPlaceholder ? "" : (msg.content ?? ""));
      try {
        // deno-lint-ignore no-explicit-any
        const leadName = (msg as any).leads?.display_name ?? undefined;
        const cls = await classify(text, msg.source ?? "unknown", verticals, anthropic, operator, classifyModel, mediaForClassify, leadName);
        const v = verticalsBySlug.get(cls.vertical_slug);
        const extra: Record<string, unknown> = {};
        if (recoveredText) {
          // Audio transcripto: el contenido pasa a ser el texto de la nota de voz.
          extra.content = recoveredText;
        } else if (mediaForClassify && cls.media_summary && cls.media_summary.trim()) {
          extra.content = `[${mediaForClassify.label}] ${cls.media_summary.trim()}`;
        }
        if (v?.ignore) {
          await supabase
            .from("messages")
            .update({ ...extra, vertical_id: v.id, classification: cls, ignored: true, ignored_reason: `vertical:${v.slug}` })
            .eq("id", msg.id)
            .is("vertical_id", null);
        } else {
          const needsReview = cls.requires_human_review || (v?.requires_review ?? false);
          await supabase
            .from("messages")
            .update({ ...extra, vertical_id: v?.id ?? null, classification: cls, requires_human_review: needsReview })
            .eq("id", msg.id)
            .is("vertical_id", null);
        }
        // Género (del nombre) + edad (si la mencionó) → al lead, igual que el flujo normal.
        await storeLeadDemographics(msg.lead_id, cls);
        await recordUsage(supabase, {
          component: "classify", model: classifyModel,
          inputTokens: cls.__usage?.input_tokens,
          outputTokens: cls.__usage?.output_tokens,
          cacheReadTokens: cls.__usage?.cache_read_input_tokens,
          // deno-lint-ignore no-explicit-any
          cacheCreation5m: (cls.__usage as any)?.cache_creation?.ephemeral_5m_input_tokens,
          leadId: msg.lead_id,
          metadata: { vertical: cls.vertical_slug, msg_id: msg.id, source: "recover" },
          pricingOverrideRaw: runtimeCfg.get("AI_PRICING_OVERRIDES"),
        });
        healed++;
      } catch (e) {
        // Reintento en el próximo ciclo del cron (fallas transitorias).
        console.warn("recover classify retry failed:", e instanceof Error ? e.message : String(e));
      }
    }
    if (healed > 0) console.log(`recoverFailedClassifications: ${healed} mensaje(s) recuperados`);
    return healed;
  } catch (e) {
    console.warn("recoverFailedClassifications:", e instanceof Error ? e.message : String(e));
    return 0;
  }
}

// ---- Tomar y procesar pending de la cola ----
async function processBatch(anthropic: Anthropic, operator: string): Promise<{ processed: number; failed: number; messageIds: string[] }> {
  // Tomar pending y marcarlos como processing (atómico)
  const { data: claimed, error: claimErr } = await supabase
    .rpc("claim_inbound_batch", { p_limit: MAX_BATCH });

  if (claimErr) {
    // Si la RPC no existe aún, fallback a select+update
    const { data: rows } = await supabase
      .from("inbound_queue")
      .select("id, payload, attempts")
      .eq("status", "pending")
      .order("created_at", { ascending: true })
      .limit(MAX_BATCH);

    if (!rows || rows.length === 0) return { processed: 0, failed: 0, messageIds: [] };

    let processed = 0, failed = 0;
    const messageIds: string[] = [];
    for (const row of rows) {
      try {
        await supabase
          .from("inbound_queue")
          .update({ status: "processing", attempts: (row.attempts ?? 0) + 1 })
          .eq("id", row.id);
        const result = await processPayload(row.payload as KommoPayload, anthropic, operator);
        messageIds.push(...result.inboundMessageIds);
        await supabase
          .from("inbound_queue")
          .update({ status: "done", processed_at: new Date().toISOString() })
          .eq("id", row.id);
        processed++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await supabase
          .from("inbound_queue")
          .update({ status: "failed", last_error: msg })
          .eq("id", row.id);
        failed++;
        console.error("process row failed:", msg);
      }
    }
    return { processed, failed, messageIds };
  }

  const rows = (claimed ?? []) as Array<{ id: string; payload: KommoPayload }>;
  if (rows.length === 0) return { processed: 0, failed: 0, messageIds: [] };

  let processed = 0, failed = 0;
  const messageIds: string[] = [];
  for (const row of rows) {
    try {
      const result = await processPayload(row.payload, anthropic, operator);
      messageIds.push(...result.inboundMessageIds);
      await supabase
        .from("inbound_queue")
        .update({ status: "done", processed_at: new Date().toISOString() })
        .eq("id", row.id);
      processed++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase
        .from("inbound_queue")
        .update({ status: "failed", last_error: msg })
        .eq("id", row.id);
      failed++;
      console.error("process row failed:", msg);
    }
  }
  return { processed, failed, messageIds };
}

Deno.serve(async (req: Request) => {
  // Healthcheck
  if (req.method === "GET") {
    return new Response("process-inbound OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }
  // deno-lint-ignore no-explicit-any
  let body: any = {};
  try {
    const t = await req.text();
    if (t) body = JSON.parse(t);
  } catch {
    // body opcional
  }
  try {
    // Resolve config at request time: DB-first, then env fallback.
    const cfg = await loadConfig(supabase);
    const anthropic = new Anthropic({ apiKey: cfg.require("ANTHROPIC_API_KEY") });
    const operator = cfg.getOr("OPERATOR_NAME", "el operador");

    // --- Reclasificación dirigida: reprocesar conversaciones puntuales ---
    // POST { reclassify_lead_ids: [<uuid>...] } → reclasifica TODOS los mensajes
    // fallidos de esos leads (más nuevos primero) y dispara generate-response por
    // lead. Útil para recuperar conversaciones tras un corte (p.ej. sin crédito).
    if (Array.isArray(body.reclassify_lead_ids) && body.reclassify_lead_ids.length) {
      const leadIds = body.reclassify_lead_ids.slice(0, 50).map(String);
      const healed = await recoverFailedClassifications(anthropic, operator, {
        leadIds,
        limit: 500,
        newestFirst: true,
      });
      let triggered = 0;
      for (const leadId of leadIds) {
        const { data: m } = await supabase
          .from("messages")
          .select("id")
          .eq("lead_id", leadId)
          .eq("direction", "inbound")
          .not("vertical_id", "is", null)
          .is("answered_by_draft_id", null)
          .eq("ignored", false)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (m?.id) {
          await fetch(`${SUPABASE_URL}/functions/v1/generate-response`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message_id: m.id }),
          }).catch((e) => console.warn("trigger generate-response failed:", e));
          triggered++;
        }
      }
      return new Response(
        JSON.stringify({ ok: true, mode: "reclassify", leadIds, healed, triggered }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    const result = await processBatch(anthropic, operator);

    // Auto-recuperación: reclasificar mensajes que fallaron por errores
    // transitorios (sin créditos, API caída). Corre en cada ciclo del cron.
    const recovered = await recoverFailedClassifications(anthropic, operator);
    // Disparamos generate-response en MODO COLA (sin message_id) para que
    // aplique el debounce: si el lead sigue escribiendo, generate-response
    // devuelve picked:null y el cron sweep (cada minuto) lo reintenta cuando
    // pasó la ventana de silencio, respondiendo todos sus mensajes juntos.
    if (result.messageIds.length > 0) {
      const trigger = fetch(`${SUPABASE_URL}/functions/v1/generate-response`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }).catch((e) => console.warn("trigger generate-response failed:", e));
      // @ts-ignore: EdgeRuntime existe en Supabase
      if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
        // @ts-ignore
        EdgeRuntime.waitUntil(trigger);
      }
    }
    return new Response(JSON.stringify({ ok: true, ...result, recovered }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("process-inbound error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});

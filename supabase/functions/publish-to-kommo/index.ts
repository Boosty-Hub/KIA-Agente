// Edge Function: publish-to-kommo
//
// Toma drafts con status='approved' y los publica a Kommo:
//   1. PATCH /api/v4/leads/{kommo_lead_id} — actualiza el custom field con la respuesta
//   2. POST  /api/v2/salesbot/run — dispara el salesbot que lee el campo y envía al canal
//
// Si publishing_enabled=false en kommo_publish_config, no hace nada (shadow mode).
//
// Soporte de comentarios de Instagram:
//   Si el draft tiene agent_metadata.from_comment=true y agent_metadata.public_reply
//   y comment_reply_enabled=true y están configurados comment_field_id + comment_salesbot_id:
//   - ANTES del flujo normal, escribe la respuesta pública (generada por IA) en
//     comment_field_id y dispara comment_salesbot_id (fail-open: si falla, el DM normal sigue).
//   - El flujo normal (campo normal + salesbot normal) SIEMPRE corre.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { loadConfig } from "../_shared/config.ts";
import {
  patchLeadField,
  runSalesbot,
  fetchOutgoingEventIds,
  verifyOutgoingDelivery,
} from "../_shared/kommo.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE, {
  auth: { persistSession: false },
});

type KommoConfig = {
  id: string;
  response_custom_field_id: number | null;
  salesbot_id: number | null;
  publishing_enabled: boolean;
  auto_reply_mode: "auto" | "review_only";
  // Línea de corte: nunca publicar drafts anteriores a esta fecha (go-live).
  publish_from: string | null;
  // Comentarios de Instagram
  comment_reply_enabled: boolean;
  comment_salesbot_id: number | null;
  comment_field_id: number | null;
};

async function getConfig(): Promise<KommoConfig | null> {
  const { data, error } = await supabase
    .from("kommo_publish_config")
    .select(
      "id, response_custom_field_id, salesbot_id, publishing_enabled, auto_reply_mode, publish_from, comment_reply_enabled, comment_salesbot_id, comment_field_id"
    )
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(`config: ${error.message}`);
  return data;
}

// ---- Selecciona drafts approved no enviados, con info del lead ----
// publishFrom: línea de corte; si está, se ignoran los drafts anteriores
// (borradores de validación viejos que NO deben dispararse al ir a producción).
async function pickPending(publishFrom: string | null, limit = 10) {
  let q = supabase
    .from("drafts")
    .select(
      "id, message_id, body, status, agent_metadata, messages!drafts_message_id_fkey(lead_id, leads(kommo_lead_id, display_name))"
    )
    .eq("status", "approved")
    .is("sent_at", null);
  if (publishFrom) q = q.gte("created_at", publishFrom);
  const { data, error } = await q.order("created_at", { ascending: true }).limit(limit);
  if (error) throw new Error(`pick drafts: ${error.message}`);
  return data ?? [];
}

// Cap duro de seguridad en profundidad: 280 chars, cortando en el último espacio.
function capPublicReply(text: string): string {
  const sanitized = text.replace(/[\n\r\t]/g, " ").trim();
  if (sanitized.length <= 280) return sanitized;
  const sub = sanitized.slice(0, 280);
  const lastSpace = sub.lastIndexOf(" ");
  return lastSpace > 0 ? sub.slice(0, lastSpace) : sub;
}

async function publishOne(
  draft: {
    id: string;
    body: string;
    agent_metadata: Record<string, unknown> | null;
    // deno-lint-ignore no-explicit-any
    messages: any;
  },
  config: KommoConfig,
  kommoDomain: string,
  kommoToken: string,
  verify: { enabled: boolean; timeoutMs: number }
): Promise<{ delivered: boolean; verified: boolean }> {
  const kommoLeadId = draft.messages?.leads?.kommo_lead_id;
  if (!kommoLeadId) throw new Error("kommo_lead_id missing");
  if (!config.response_custom_field_id) throw new Error("response_custom_field_id no configurado");
  if (!config.salesbot_id) throw new Error("salesbot_id no configurado");

  const leadId = Number(kommoLeadId);
  const meta = draft.agent_metadata ?? {};

  // ---- Respuesta pública IA (comentario de Instagram) — fail-open ----
  // Usa meta.public_reply generado por Haiku en generate-response.
  // Corre ANTES del flujo normal; si falla, el DM normal sigue igual.
  const rawPublicReply = typeof meta.public_reply === "string" ? meta.public_reply : null;
  if (
    meta.from_comment === true &&
    config.comment_reply_enabled &&
    config.comment_salesbot_id != null &&
    config.comment_field_id != null &&
    rawPublicReply
  ) {
    try {
      const publicText = capPublicReply(rawPublicReply);
      await patchLeadField(leadId, config.comment_field_id, publicText, kommoDomain, kommoToken);
      await runSalesbot(config.comment_salesbot_id, leadId, kommoDomain, kommoToken);
    } catch (err) {
      console.warn(
        `publish-to-kommo: respuesta pública comentario (draft ${draft.id}) falló — continúa con DM:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }

  // ---- Flujo normal: DM por campo + salesbot estándar ----
  // SIEMPRE corre, independientemente de si la parte pública falló.
  // Antes de disparar, tomamos una "foto" de los mensajes salientes que el lead YA
  // tenía, para poder detectar el NUEVO que (si todo va bien) genere el salesbot.
  const baseline = verify.enabled
    ? await fetchOutgoingEventIds(leadId, kommoDomain, kommoToken)
    : new Set<string>();

  await patchLeadField(leadId, config.response_custom_field_id, draft.body, kommoDomain, kommoToken);
  await runSalesbot(config.salesbot_id, leadId, kommoDomain, kommoToken);

  // El 202 success:true de salesbot/run NO prueba la entrega (ver _shared/kommo.ts).
  // Verificamos que haya aparecido un outgoing_chat_message nuevo del lead.
  if (!verify.enabled) return { delivered: true, verified: false };
  const delivered = await verifyOutgoingDelivery(
    leadId,
    baseline,
    kommoDomain,
    kommoToken,
    verify.timeoutMs
  );
  return { delivered, verified: true };
}

Deno.serve(async (req: Request) => {
  if (req.method === "GET") {
    return new Response("publish-to-kommo OK", { status: 200 });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  try {
    // Resolve config at request time: DB-first, then env fallback.
    const runtimeCfg = await loadConfig(supabase);
    const kommoDomain = runtimeCfg.require("KOMMO_API_DOMAIN");
    const kommoToken = runtimeCfg.require("KOMMO_ACCESS_TOKEN");

    const config = await getConfig();
    if (!config) {
      return new Response(
        JSON.stringify({ ok: true, skipped: "no config" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (!config.publishing_enabled) {
      return new Response(
        JSON.stringify({ ok: true, skipped: "publishing disabled (shadow mode)" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    // Verificador de entrega (DB-first / env-fallback). El default es ON: el
    // salesbot/run devuelve 202 success aunque el bot no entregue, así que sin esto
    // marcaríamos "enviado" en falso. SALESBOT_VERIFY_ENABLED="false" lo apaga
    // (vuelve al comportamiento previo); SALESBOT_VERIFY_TIMEOUT_MS ajusta la ventana.
    const verify = {
      enabled: runtimeCfg.getOr("SALESBOT_VERIFY_ENABLED", "true") !== "false",
      timeoutMs: Math.max(
        3000,
        Number(runtimeCfg.getOr("SALESBOT_VERIFY_TIMEOUT_MS", "12000")) || 12000
      ),
    };

    const pending = await pickPending(config.publish_from);
    if (pending.length === 0) {
      return new Response(JSON.stringify({ ok: true, published: 0 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // El trabajo de publicación es LENTO (verificación de entrega: hasta
    // verify.timeoutMs por cada draft NO entregado) y este endpoint se dispara
    // fire-and-forget (cron pg_net con timeout 30s, y /api/drafts/[id]/approve sin
    // await). Si corriéramos el loop antes de responder, el runtime mataría la función
    // al desconectarse el cliente (invariante #2). Por eso va en waitUntil y
    // respondemos 202 de inmediato.
    const processBatch = async () => {
      let published = 0;
      let undelivered = 0;
      let failed = 0;

      for (const d of pending) {
        const baseMeta = (d.agent_metadata as Record<string, unknown> | null) ?? {};
        try {
          const result = await publishOne(d, config, kommoDomain, kommoToken, verify);

          if (result.delivered) {
            await supabase
              .from("drafts")
              .update({
                status: "auto_sent",
                sent_at: new Date().toISOString(),
                agent_metadata: result.verified
                  ? { ...baseMeta, delivery_verified: true }
                  : baseMeta,
              })
              .eq("id", d.id);
            published++;
          } else {
            // El bot se disparó (Kommo respondió OK) pero NO apareció un mensaje
            // saliente en la ventana: el mensaje NO llegó al canal. No es un "enviado".
            await supabase
              .from("drafts")
              .update({
                status: "failed",
                agent_metadata: {
                  ...baseMeta,
                  delivery_unverified: true,
                  publish_error:
                    "salesbot disparado pero sin entrega confirmada (no apareció outgoing_chat_message)",
                },
              })
              .eq("id", d.id);

            const leadName =
              d.messages?.leads?.display_name ??
              `lead ${d.messages?.leads?.kommo_lead_id ?? "?"}`;
            const { error: alertErr } = await supabase.from("alerts").insert({
              kind: "salesbot_not_delivered",
              severity: "warning",
              title: `No se confirmó la entrega del mensaje a ${leadName}`,
              description:
                "El salesbot se disparó y Kommo respondió OK, pero no apareció un mensaje saliente en el canal dentro de la ventana de verificación. " +
                "Causas probables: ventana de mensajería de Instagram (24h) vencida, lead venido de un comentario sin DM abierto, o el bot con una condición que lo corta. " +
                "Revisá la conversación y, si corresponde, respondé manualmente.",
              ref_table: "drafts",
              ref_id: d.id,
              metadata: {
                kommo_lead_id: d.messages?.leads?.kommo_lead_id ?? null,
                lead_id: d.messages?.lead_id ?? null,
              },
            });
            if (alertErr) console.warn("alert salesbot_not_delivered:", alertErr.message);
            undelivered++;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          await supabase
            .from("drafts")
            .update({
              status: "failed",
              agent_metadata: { ...baseMeta, publish_error: msg },
            })
            .eq("id", d.id);
          console.warn(`publish-to-kommo: draft ${d.id} falló:`, msg);
          failed++;
        }
      }

      // Tras publicar al menos un mensaje ENTREGADO, disparar evaluación de outcomes.
      if (published > 0) {
        await fetch(`${SUPABASE_URL}/functions/v1/evaluate-outcomes`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        }).catch((e) => console.warn("trigger evaluate-outcomes:", e));
      }

      console.log(
        `publish-to-kommo: published=${published} undelivered=${undelivered} failed=${failed}`
      );
    };

    // @ts-ignore EdgeRuntime de Supabase
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(processBatch());
    } else {
      // Runtime sin waitUntil (p.ej. test local): correr inline.
      await processBatch();
    }

    return new Response(JSON.stringify({ ok: true, accepted: pending.length }), {
      status: 202,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("publish-to-kommo error:", msg);
    return new Response(JSON.stringify({ ok: false, error: msg }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
});

// _shared/history.ts
// Reconstruye el transcript RECIENTE de la conversación de un lead para dar
// CONTEXTO al clasificador (process-inbound) y al agente (generate-response).
//
// Sin esto, el clasificador ve solo el mensaje actual (aislado) y el agente solo
// el batch de inbound sin responder — ninguno "ve" la conversación real (lo que
// ya se le dijo al lead, las respuestas previas, el seguimiento). Acá juntamos
// dos fuentes de la DB y las mergeamos por tiempo:
//   - messages: lado del LEAD (inbound) + cualquier outbound capturado.
//   - drafts ENVIADOS: las respuestas reales del agente (que NO siempre quedan
//     en messages como outbound).
//
// Lado "asesora" (outbound msg + drafts) se DEDUPLICA por cercanía temporal +
// texto equivalente: la respuesta del agente puede aparecer como draft y, si Kommo
// la rebotó por webhook, también como mensaje outbound (a veces saneado, sin
// emojis) — la mostramos una sola vez, sin borrar reenvíos legítimos de la misma
// plantilla en días distintos. Fail-open: ante error, devuelve [].

// deno-lint-ignore-file no-explicit-any
type Supa = any;

export type HistoryTurn = { at: number; role: "lead" | "asesora"; text: string };

const TURN_CAP = 300;
function clip(s: string): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > TURN_CAP ? t.slice(0, TURN_CAP - 1) + "…" : t;
}
// Clave de comparación para deduplicar el lado "asesora": saca los caracteres
// no-BMP (emojis) — igual que sanitizeKommoFieldValue al escribir en Kommo — para
// que un draft con emoji y su eco outbound saneado matcheen. Lower + collapse.
function cmpKey(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || cp > 0xffff) continue;
    out += ch;
  }
  return out.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function fetchRecentHistory(
  supabase: Supa,
  leadId: string,
  opts: { limit?: number; excludeMessageIds?: string[] } = {}
): Promise<HistoryTurn[]> {
  const limit = Math.max(1, opts.limit ?? 15);
  const exclude = new Set(opts.excludeMessageIds ?? []);
  const all: HistoryTurn[] = [];
  try {
    // Mensajes (ambas direcciones). Sobre-pedimos para mergear y recortar luego.
    const { data: msgs } = await supabase
      .from("messages")
      .select("id, content, direction, created_at")
      .eq("lead_id", leadId)
      .order("created_at", { ascending: false })
      .limit(limit * 2);
    const msgIds: string[] = [];
    for (const m of (msgs ?? []) as any[]) {
      msgIds.push(m.id as string);
      if (exclude.has(m.id)) continue;
      const text = clip(String(m.content ?? ""));
      if (!text) continue;
      all.push({
        at: new Date(m.created_at).getTime(),
        role: m.direction === "inbound" ? "lead" : "asesora",
        text,
      });
    }
    // Respuestas ENTREGADAS del agente (drafts). Solo 'sent'/'auto_sent' = envío
    // real al lead; 'approved' es PRE-entrega (en shadow mode con publishing_enabled
    // =false queda 'approved' y nunca se entrega), y 'pending'/'failed' tampoco
    // salieron — los excluimos para no "creer" que ya se le respondió al lead.
    // Filtramos por los message_id ya traídos (drafts.message_id apunta al mensaje
    // más reciente de su batch) → evita el embed ambiguo drafts↔messages (2 FKs).
    if (msgIds.length > 0) {
      const { data: drafts } = await supabase
        .from("drafts")
        .select("body, created_at, message_id, status")
        .in("message_id", msgIds)
        .in("status", ["sent", "auto_sent"]);
      for (const d of (drafts ?? []) as any[]) {
        const text = clip(String(d.body ?? ""));
        if (!text) continue;
        all.push({ at: new Date(d.created_at).getTime(), role: "asesora", text });
      }
    }
  } catch (_e) {
    return [];
  }
  // Orden cronológico ascendente + dedup del lado "asesora". La misma respuesta
  // puede venir como draft Y como su eco outbound (a veces saneado, sin emojis)
  // casi al mismo tiempo. Colapsamos SOLO duplicados CERCANOS EN EL TIEMPO con
  // texto equivalente (uno prefijo del otro, comparando sin no-BMP) → así NO
  // borramos reenvíos legítimos de la misma plantilla en momentos distintos. El
  // lado "lead" nunca se deduplica (un lead puede repetir "No" legítimamente).
  all.sort((a, b) => a.at - b.at);
  const DEDUP_WINDOW_MS = 180_000;
  const kept: Array<{ at: number; key: string }> = [];
  const out: HistoryTurn[] = [];
  for (const t of all) {
    if (t.role === "asesora") {
      const key = cmpKey(t.text);
      const dup =
        key.length >= 8 &&
        kept.some(
          (k) =>
            k.key.length >= 8 &&
            Math.abs(k.at - t.at) <= DEDUP_WINDOW_MS &&
            (k.key.startsWith(key) || key.startsWith(k.key))
        );
      if (dup) continue;
      kept.push({ at: t.at, key });
    }
    out.push(t);
  }
  return out.slice(-limit);
}

export function formatHistory(turns: HistoryTurn[], tz = "America/Caracas"): string {
  if (!turns.length) return "";
  return turns
    .map((t) => {
      let hhmm = "";
      try {
        hhmm = new Intl.DateTimeFormat("es", {
          timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
        }).format(new Date(t.at));
      } catch { /* sin hora */ }
      return `${hhmm ? `[${hhmm}] ` : ""}${t.role === "lead" ? "lead" : "asesora"}: ${t.text}`;
    })
    .join("\n");
}

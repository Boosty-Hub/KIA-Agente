import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const form = await request.formData();
  const fieldId = form.get("response_custom_field_id")?.toString().trim();
  const botId = form.get("salesbot_id")?.toString().trim();
  const enabled = form.get("publishing_enabled") === "on";
  const agentEnabled = form.get("agent_enabled") === "on";
  // bypass_review solo puede quedar true si publishing también está habilitado.
  const bypassReview = form.get("bypass_review") === "on" && enabled;
  const autoMode = form.get("auto_reply_mode")?.toString() ?? "auto";

  // NOTA: los límites de respuesta por lead (cooldown / tope) se configuran en
  // /agent → tab Filtros (POST /api/response-limits). NO se tocan acá para no
  // pisarlos cuando se guarda la config de publicación.
  const update: Record<string, unknown> = {
    response_custom_field_id: fieldId ? Number(fieldId) : null,
    salesbot_id: botId ? Number(botId) : null,
    publishing_enabled: enabled,
    agent_enabled: agentEnabled,
    bypass_review: bypassReview,
    auto_reply_mode: autoMode === "review_only" ? "review_only" : "auto",
  };

  // Línea de corte de publicación (go-live): la PRIMERA vez que el sistema queda
  // habilitado para publicar de verdad (publishing on + salesbot cargado) y aún
  // no hay corte, marcamos "desde ahora". Así los borradores de validación viejos
  // NUNCA se disparan al activar el salesbot. Idempotente: no se re-estampa.
  const { data: current } = await supabase
    .from("kommo_publish_config")
    .select("publish_from")
    .eq("is_active", true)
    .maybeSingle();
  if (enabled && botId && !current?.publish_from) {
    update.publish_from = new Date().toISOString();
  }

  const { error } = await supabase
    .from("kommo_publish_config")
    .update(update)
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.redirect(new URL("/settings?saved=1", request.url), { status: 303 });
}

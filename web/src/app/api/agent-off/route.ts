import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { requireAdmin } from "@/lib/auth/guard";

// Configura el campo "Apagar Agente": guarda el id (+ nombre) del campo de Kommo
// que actúa como interruptor por lead. null = desactivado. Solo-admin (config).
export async function POST(request: Request) {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const supabase = createSupabaseServerClient();

  const body = await request.json();
  const id = Number(body.fieldId);
  const valid = Number.isFinite(id) && id > 0;

  const { error } = await supabase
    .from("kommo_publish_config")
    .update({
      agent_off_field_id: valid ? id : null,
      agent_off_field_name: valid && body.fieldName ? String(body.fieldName) : null,
    })
    .eq("is_active", true);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

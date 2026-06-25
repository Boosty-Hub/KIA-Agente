import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";

// Normaliza un precio: acepta number o string ("$23.026", "47,522", "") y
// devuelve number o null. null = "consultar".
function parsePrice(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export async function POST(request: Request) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await request.json();
  const name = String(body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "nombre requerido" }, { status: 400 });

  const { error } = await supabase.from("vehicles").insert({
    name,
    price_usd: parsePrice(body.price_usd),
    description: String(body.description ?? ""),
    enabled: body.enabled === undefined ? true : body.enabled === true,
    sort_order: Number.isFinite(Number(body.sort_order)) ? Number(body.sort_order) : 0,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

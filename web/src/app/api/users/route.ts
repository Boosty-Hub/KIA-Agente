export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guard";
import { listAllUsers, createUser } from "@/lib/provision/admin";

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function env() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srk) return null;
  return { url, srk };
}

// GET — lista todos los usuarios (admin-only).
export async function GET(): Promise<NextResponse> {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const e = env();
  if (!e) return NextResponse.json({ error: "Supabase env not configured" }, { status: 503 });
  try {
    const users = await listAllUsers(e.url, e.srk);
    return NextResponse.json({ users });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}

// POST — crea un usuario con rol (admin-only).
export async function POST(request: Request): Promise<NextResponse> {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const e = env();
  if (!e) return NextResponse.json({ error: "Supabase env not configured" }, { status: 503 });

  let body: { email?: string; password?: string; role?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const role = body.role === "editor" ? "editor" : body.role === "admin" ? "admin" : null;

  const fieldErrors: Record<string, string> = {};
  if (!isValidEmail(email)) fieldErrors.email = "Email inválido";
  if (password.length < 8) fieldErrors.password = "La contraseña debe tener al menos 8 caracteres";
  if (!role) fieldErrors.role = "Elegí un rol (admin o editor)";
  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json({ fieldErrors }, { status: 400 });
  }

  try {
    await createUser(e.url, e.srk, email, password, role!);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // gotrue devuelve 422 si el email ya existe.
    const dup = /already|registered|exists|422|duplicate/i.test(msg);
    return NextResponse.json(
      { error: dup ? "Ya existe un usuario con ese email." : msg },
      { status: dup ? 409 : 502 }
    );
  }
}

// INVARIANT: this route MUST NOT import @/lib/runtime-config or
// @/lib/supabase/service. It uses the provision lib layer only.
//
// Guarda (y revalida) un Supabase Personal Access Token nuevo en runtime_config.
// Es el camino self-serve para reconectar cuando el token guardado venció/se
// revocó (el centro de actualizaciones lo reporta como `tokenInvalid`). Valida
// el token contra el Management API ANTES de persistirlo, así el operador sabe
// al instante si el PAT nuevo sirve — sin re-correr el wizard ni tocar código.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getRef } from "@/lib/provision/ref";
import { runQuery, isAuthError } from "@/lib/provision/management";
import { saveAccessToken } from "@/lib/provision/config-token";

export async function POST(request: Request): Promise<NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json(
      { ok: false, error: "Supabase env no configurado" },
      { status: 503 }
    );
  }

  let body: { accessToken?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const token = typeof body.accessToken === "string" ? body.accessToken.trim() : "";
  if (!token) {
    return NextResponse.json(
      { ok: false, error: "Pegá un Personal Access Token (sbp_…)." },
      { status: 400 }
    );
  }

  const ref = getRef(supabaseUrl);

  // Validar contra el Management API con la misma operación que usamos en runtime.
  try {
    await runQuery(ref, token, "select 1 as ok");
  } catch (err) {
    if (isAuthError(err)) {
      return NextResponse.json(
        {
          ok: false,
          tokenInvalid: true,
          error:
            "El Management API rechaza ese token (401/403). Verificá que sea un PAT válido y con acceso a este proyecto.",
        },
        { status: 401 }
      );
    }
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ ok: false, error: msg }, { status: 502 });
  }

  // Token válido → persistir en runtime_config.
  const saved = await saveAccessToken(supabaseUrl, serviceRoleKey, token).catch(
    () => false
  );
  if (!saved) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "El token es válido pero no se pudo guardar (¿runtime_config no existe? corré el wizard).",
      },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}

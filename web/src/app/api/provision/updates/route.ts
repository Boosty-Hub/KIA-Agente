// INVARIANT: this route MUST NOT import @/lib/runtime-config or
// @/lib/supabase/service. It uses the provision lib layer only.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { MIGRATIONS } from "@/lib/provision/migrations.generated";
import { FUNCTIONS } from "@/lib/provision/functions.generated";
import { getRef } from "@/lib/provision/ref";
import { runQuery, listFunctions, isAuthError } from "@/lib/provision/management";
import { readAccessToken } from "@/lib/provision/config-token";
import { readDeployedHashes } from "@/lib/provision/function-hashes";

type FnStatus = "missing" | "changed" | "ok";

// Respuesta cuando hay un token guardado pero el Management API lo rechaza
// (401/403 — PAT vencido/revocado). NO inventamos "drift": reportar todas las
// migraciones pendientes + todas las funciones cambiadas dispararía un
// auto-update condenado a fallar (502). En su lugar marcamos `tokenInvalid`
// para que el front muestre un CTA de "reconectá tu token".
function invalidTokenResponse(totalMig: number, totalFn: number) {
  return NextResponse.json({
    ok: true,
    hasSupabaseEnv: true,
    hasToken: true,
    tokenInvalid: true,
    migrations: { applied: 0, total: totalMig, pending: [] },
    functions: { total: totalFn, items: [] as { slug: string; status: FnStatus }[] },
  });
}

export async function GET(): Promise<NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const totalMig = MIGRATIONS.length;
  const totalFn = FUNCTIONS.length;

  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({
      ok: false,
      hasSupabaseEnv: false,
      error: "Supabase env no configurado",
    });
  }

  const token = await readAccessToken(supabaseUrl, serviceRoleKey);
  if (!token) {
    return NextResponse.json({
      ok: true,
      hasSupabaseEnv: true,
      hasToken: false,
      migrations: { applied: 0, total: totalMig, pending: [] },
      functions: { total: totalFn, items: [] },
    });
  }

  const ref = getRef(supabaseUrl);

  // ── Migraciones pendientes ──────────────────────────────────────────────
  let appliedCount = 0;
  let pending: string[] = [];
  try {
    const rows = (await runQuery(
      ref,
      token,
      "SELECT filename FROM _migrations ORDER BY filename"
    )) as Array<{ filename: string }>;
    const applied = new Set(rows.map((r) => r.filename));
    appliedCount = applied.size;
    pending = MIGRATIONS.map((m) => m.filename).filter((f) => !applied.has(f));
  } catch (e) {
    // Token vencido/revocado (401/403): cortamos acá, sin fabricar drift.
    if (isAuthError(e)) return invalidTokenResponse(totalMig, totalFn);
    // _migrations no existe (DB nueva) → todas pendientes.
    pending = MIGRATIONS.map((m) => m.filename);
  }

  // ── Funciones: faltantes (no desplegadas) o cambiadas (hash distinto) ─────
  const items: { slug: string; status: FnStatus }[] = [];
  try {
    const deployed = await listFunctions(ref, token);
    const deployedSlugs = new Set(deployed.map((f) => f.slug));
    const storedHashes = await readDeployedHashes(supabaseUrl, serviceRoleKey);
    for (const fn of FUNCTIONS) {
      let status: FnStatus;
      if (!deployedSlugs.has(fn.slug)) {
        status = "missing";
      } else if (storedHashes[fn.slug] !== fn.hash) {
        // Desplegada pero el hash no coincide (o nunca se registró) → cambió.
        status = "changed";
      } else {
        status = "ok";
      }
      items.push({ slug: fn.slug, status });
    }
  } catch (e) {
    // Token vencido/revocado: reconectar, no redeploy masivo.
    if (isAuthError(e)) return invalidTokenResponse(totalMig, totalFn);
    // Management API falló por otra causa → no podemos saber; marcamos todas
    // como changed para que el operador pueda forzar el redeploy.
    for (const fn of FUNCTIONS) items.push({ slug: fn.slug, status: "changed" });
  }

  return NextResponse.json({
    ok: true,
    hasSupabaseEnv: true,
    hasToken: true,
    tokenInvalid: false,
    migrations: { applied: appliedCount, total: totalMig, pending },
    functions: { total: totalFn, items },
  });
}

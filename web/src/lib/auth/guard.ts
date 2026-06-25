// lib/auth/guard.ts
// Guard server-side para rutas API solo-admin. Verifica sesión + rol admin.
import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { roleFromUser } from "@/lib/auth/roles";
import { listUsersHead } from "@/lib/provision/admin";

export type AdminGuard =
  | { user: { id: string; email: string | null } }
  | { res: NextResponse };

/**
 * Devuelve { user } si el caller está logueado y es admin; si no, { res } con
 * el NextResponse de error (401/403) para devolver tal cual. Uso:
 *   const g = await requireAdmin();
 *   if ("res" in g) return g.res;
 *   // ... g.user
 */
export async function requireAdmin(): Promise<AdminGuard> {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { res: NextResponse.json({ error: "unauthorized" }, { status: 401 }) };
  }
  if (roleFromUser(user) !== "admin") {
    return {
      res: NextResponse.json(
        { error: "forbidden", message: "Requiere rol admin." },
        { status: 403 }
      ),
    };
  }
  return { user: { id: user.id, email: user.email ?? null } };
}

/**
 * Exige sesión admin SOLO si el sistema ya pasó el first-run (ya hay ≥1 usuario).
 * Durante el first-run real (sin usuarios) permite. Útil para rutas de provisioning
 * que el wizard usa antes de crear el usuario, pero que post-setup no deben quedar
 * abiertas. Devuelve null si OK, o el NextResponse de error.
 */
export async function requireAdminPostFirstRun(
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<NextResponse | null> {
  let usersExist = true;
  try {
    usersExist = (await listUsersHead(supabaseUrl, serviceRoleKey)).users.length > 0;
  } catch {
    usersExist = true; // ante la duda, fail-closed (tratar como post-first-run)
  }
  if (!usersExist) return null;
  const g = await requireAdmin();
  return "res" in g ? g.res : null;
}

/**
 * Guard para rutas de provisioning que pueden usar el PAT GUARDADO en runtime_config.
 * Si el caller trae su PROPIO token en el body, se permite (necesita un PAT válido
 * igual, el Management API lo rechaza si no). Si NO trae token, el camino usaría el
 * PAT guardado → post-first-run exige admin. El wizard SIEMPRE manda token en el body.
 */
export async function guardProvisionStoredToken(
  supabaseUrl: string,
  serviceRoleKey: string,
  hasBodyToken: boolean
): Promise<NextResponse | null> {
  if (hasBodyToken) return null;
  return requireAdminPostFirstRun(supabaseUrl, serviceRoleKey);
}

// lib/provision/admin.ts
// Supabase Auth Admin API helpers.
//
// These functions use plain fetch with the service-role key (passed as Bearer
// token to the Auth Admin endpoint). They MUST NOT import runtime-config.ts
// or service.ts — they build clients inline from caller-supplied credentials
// or process.env, so they are safe to use before the DB schema exists.

// ─── LIST USERS (head / count check) ─────────────────────────────────────────

export interface AdminUsersPage {
  users: Array<{
    id: string;
    email?: string;
    created_at: string;
  }>;
  aud: string;
}

/**
 * Fetch the first page of admin users (page=1, per_page=1).
 * Used as a cheap "does at least one user exist?" check.
 */
export async function listUsersHead(
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<AdminUsersPage> {
  const res = await fetch(
    `${supabaseUrl}/auth/v1/admin/users?page=1&per_page=1`,
    {
      cache: "no-store",
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Admin listUsers failed (${res.status}): ${text}`
    );
  }

  return res.json() as Promise<AdminUsersPage>;
}

// ─── CREATE USER ─────────────────────────────────────────────────────────────

export interface CreatedUser {
  id: string;
  email: string;
  created_at: string;
}

/**
 * Create a new user via the Auth Admin API.
 * Uses email_confirm: true so the user can log in immediately.
 *
 * INVARIANT: email_confirm must always be true (no email confirmation flow
 * in single-tenant first-run setup).
 */
export async function createUser(
  supabaseUrl: string,
  serviceRoleKey: string,
  email: string,
  password: string,
  role?: "admin" | "editor"
): Promise<CreatedUser> {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      password,
      email_confirm: true, // INVARIANT: always true
      // El rol vive en app_metadata (server-set, va en el JWT). Sin rol explícito
      // → el lector lo trata como admin (legacy/master). Ver lib/auth/roles.ts.
      ...(role ? { app_metadata: { role } } : {}),
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Admin createUser failed (${res.status}): ${text}`
    );
  }

  return res.json() as Promise<CreatedUser>;
}

// ─── MANAGE USERS (módulo /usuarios, admin-only) ─────────────────────────────

export interface AdminUser {
  id: string;
  email: string | null;
  role: "admin" | "editor";
  created_at: string;
  last_sign_in_at: string | null;
}

interface RawAdminUser {
  id: string;
  email?: string | null;
  app_metadata?: { role?: string } | null;
  created_at: string;
  last_sign_in_at?: string | null;
}

function toAdminUser(u: RawAdminUser): AdminUser {
  return {
    id: u.id,
    email: u.email ?? null,
    role: u.app_metadata?.role === "editor" ? "editor" : "admin",
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at ?? null,
  };
}

/** Lista TODOS los usuarios (paginado de a 100, tope defensivo de 20 páginas). */
export async function listAllUsers(
  supabaseUrl: string,
  serviceRoleKey: string
): Promise<AdminUser[]> {
  const out: AdminUser[] = [];
  for (let page = 1; page <= 20; page++) {
    const res = await fetch(
      `${supabaseUrl}/auth/v1/admin/users?page=${page}&per_page=100`,
      {
        cache: "no-store",
        headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
      }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Admin listUsers failed (${res.status}): ${text}`);
    }
    const json = (await res.json()) as { users?: RawAdminUser[] };
    const users = json.users ?? [];
    for (const u of users) out.push(toAdminUser(u));
    if (users.length < 100) break;
  }
  return out;
}

/** Actualiza password y/o rol (app_metadata se mergea, no se pisa). */
export async function updateAuthUser(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string,
  patch: { password?: string; role?: "admin" | "editor" }
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.password) body.password = patch.password;
  if (patch.role) body.app_metadata = { role: patch.role };
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: "PUT",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Admin updateUser failed (${res.status}): ${text}`);
  }
}

/** Borra un usuario. */
export async function deleteAuthUser(
  supabaseUrl: string,
  serviceRoleKey: string,
  userId: string
): Promise<void> {
  const res = await fetch(`${supabaseUrl}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Admin deleteUser failed (${res.status}): ${text}`);
  }
}

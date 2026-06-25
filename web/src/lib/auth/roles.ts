// lib/auth/roles.ts
// Modelo de roles del panel. El rol vive en Supabase Auth `app_metadata.role`
// (server-set vía Admin API, va en el JWT y lo devuelve getUser()). NO hay tabla
// ni RLS nueva. Edge-safe (TS puro, sin deps de node) → se usa en el middleware.

export type Role = "admin" | "editor";

type WithAppMetadata = { app_metadata?: Record<string, unknown> | null } | null | undefined;

/**
 * Rol del usuario. Un usuario SIN rol explícito (el master/legacy creado antes de
 * existir roles) se trata como **admin** para que nunca pierda acceso. Solo un
 * `app_metadata.role === "editor"` baja a editor.
 */
export function roleFromUser(user: WithAppMetadata): Role {
  return user?.app_metadata?.role === "editor" ? "editor" : "admin";
}

// Módulos SOLO-ADMIN: páginas + sus rutas API. Un editor NO entra acá.
// El editor SÍ puede: inbox, leads, novedades, vehiculos, contenido, alerts
// (y las APIs que esos módulos usan, que NO están en esta lista).
export const ADMIN_ONLY_PREFIXES: readonly string[] = [
  // ── Páginas ──
  "/settings",
  "/agent",
  "/tools",
  "/verticales",
  "/seguimiento",
  "/dreams",
  "/outcomes",
  "/consumo",
  "/usuarios",
  "/setup",
  // ── Rutas API (configuración técnica + gestión) ──
  "/api/settings",
  "/api/shopify",
  "/api/tools",
  "/api/verticales",
  "/api/follow-up",
  "/api/dreams",
  "/api/graders",
  "/api/usage",
  "/api/users",
  "/api/setup",
  "/api/agent", // distinto de /api/agent-off, que se lista aparte abajo
  "/api/agent-off",
  "/api/media-response",
  "/api/kommo", // lookups/escrituras de Kommo, solo desde settings/agent/seguimiento (admin)
  "/api/response-debounce",
  "/api/response-freshness",
  "/api/response-limits",
  "/api/skip-rules",
  "/api/filters",
];

/**
 * Match exacto o prefijo seguido de "/". El "+'/'" evita que "/api/agent" se
 * trague endpoints distintos como "/api/agent-off" (que se gatea por separado,
 * con su propia entrada en la lista).
 */
export function isAdminOnlyPath(pathname: string): boolean {
  return ADMIN_ONLY_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/")
  );
}

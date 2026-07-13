import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { roleFromUser, isAdminOnlyPath } from "@/lib/auth/roles";
import { EMBED_COOKIE_OPTIONS } from "./cookie-options";

export async function updateSession(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── NO-ENV GUARD ─────────────────────────────────────────────────────────
  // When Supabase env vars are absent the app is not yet connected.
  // Allow static assets, the first-run wizard pages, and provision API routes
  // to pass through; redirect everything else to /first-run.
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const isPublicAsset =
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/api/provision") ||
    pathname.startsWith("/first-run");

  if (!url || !anon) {
    if (isPublicAsset) {
      return NextResponse.next({ request });
    }
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/first-run";
    return NextResponse.redirect(redirectUrl, { status: 307 });
  }
  // ── END NO-ENV GUARD ─────────────────────────────────────────────────────

  // Both env vars are confirmed defined — build the client with locals (no !)
  let supabaseResponse = NextResponse.next({ request });

  // Embed context (computed early so the refreshed session cookies get CHIPS
  // attrs and survive the Hub's cross-site iframe — see cookie-options).
  const requestedMode = request.nextUrl.searchParams.get("mode");
  const embedActive = requestedMode === "embed" || request.cookies.get("embed_mode")?.value === "1";

  const supabase = createServerClient(url, anon, {
    ...(embedActive ? { cookieOptions: EMBED_COOKIE_OPTIONS } : {}),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Rutas públicas (post-connection)
  const isPublic =
    pathname === "/login" ||
    pathname.startsWith("/auth") ||
    pathname.startsWith("/_next") ||
    pathname === "/favicon.ico" ||
    pathname.startsWith("/api/provision") ||
    pathname.startsWith("/first-run");

  if (!user && !isPublic) {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/login";
    return NextResponse.redirect(redirectUrl);
  }

  if (user && pathname === "/login") {
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/inbox";
    return NextResponse.redirect(redirectUrl);
  }

  // ── Gate por rol ──────────────────────────────────────────────────────────
  // Un editor no accede a los módulos solo-admin (config técnica + usuarios).
  // Chokepoint único: cubre páginas Y rutas API. getUser() trae app_metadata
  // fresco del servidor, así un cambio de rol aplica en el acto.
  if (user && roleFromUser(user) === "editor" && isAdminOnlyPath(pathname)) {
    if (pathname.startsWith("/api/")) {
      return new NextResponse(
        JSON.stringify({ error: "forbidden", message: "Requiere rol admin." }),
        { status: 403, headers: { "content-type": "application/json" } }
      );
    }
    const redirectUrl = request.nextUrl.clone();
    redirectUrl.pathname = "/inbox";
    return NextResponse.redirect(redirectUrl);
  }

  // ── Modo embed (Boosty Hub workspace) ─────────────────────────────────────
  // ?mode=embed activa la persistencia embebida; ?mode=normal la desactiva. La
  // cookie embed_mode lleva atributos CHIPS para sobrevivir el iframe cross-site.
  if (requestedMode === "embed") {
    supabaseResponse.cookies.set("embed_mode", "1", {
      path: "/",
      httpOnly: true,
      ...EMBED_COOKIE_OPTIONS,
    });
  } else if (requestedMode === "normal") {
    supabaseResponse.cookies.delete("embed_mode");
  }

  // Solo en modo embed abrimos el CSP para permitir el iframe del Hub; el default
  // seguro (frame-ancestors 'self') lo pone next.config.
  if (embedActive) {
    const origins = (process.env.EMBED_ORIGINS || "*").replace(/[\r\n]/g, "");
    supabaseResponse.headers.set("Content-Security-Policy", `frame-ancestors ${origins}`);
  }

  return supabaseResponse;
}

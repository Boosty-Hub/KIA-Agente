import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { roleFromUser, isAdminOnlyPath } from "@/lib/auth/roles";

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

  const supabase = createServerClient(url, anon, {
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

  return supabaseResponse;
}

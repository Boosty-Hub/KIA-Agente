export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth/guard";
import { listAllUsers, updateAuthUser, deleteAuthUser } from "@/lib/provision/admin";

function env() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !srk) return null;
  return { url, srk };
}

// PATCH — cambia rol y/o contraseña (admin-only).
export async function PATCH(
  request: Request,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const e = env();
  if (!e) return NextResponse.json({ error: "Supabase env not configured" }, { status: 503 });
  const { id } = params;

  let body: { password?: string; role?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const patch: { password?: string; role?: "admin" | "editor" } = {};
  const fieldErrors: Record<string, string> = {};

  if (typeof body.password === "string" && body.password.length > 0) {
    if (body.password.length < 8) fieldErrors.password = "Mínimo 8 caracteres";
    else patch.password = body.password;
  }
  if (body.role !== undefined) {
    if (body.role !== "admin" && body.role !== "editor") fieldErrors.role = "Rol inválido";
    else patch.role = body.role;
  }
  if (Object.keys(fieldErrors).length > 0) {
    return NextResponse.json({ fieldErrors }, { status: 400 });
  }
  if (!patch.password && !patch.role) {
    return NextResponse.json({ error: "Nada para actualizar" }, { status: 400 });
  }

  // No degradarse a sí mismo (evita auto-bloqueo).
  if (patch.role === "editor" && id === g.user.id) {
    return NextResponse.json(
      { error: "No podés quitarte el rol admin a vos mismo." },
      { status: 400 }
    );
  }

  // No dejar el sistema sin admins.
  if (patch.role === "editor") {
    try {
      const users = await listAllUsers(e.url, e.srk);
      const target = users.find((u) => u.id === id);
      const admins = users.filter((u) => u.role === "admin");
      if (target?.role === "admin" && admins.length <= 1) {
        return NextResponse.json(
          { error: "Es el único admin; no se puede degradar a editor." },
          { status: 400 }
        );
      }
    } catch (err) {
      return NextResponse.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 502 }
      );
    }
  }

  try {
    await updateAuthUser(e.url, e.srk, id, patch);
    // Cierre de la ventana TOCTOU del guard de "último admin": si una degradación
    // concurrente dejó el sistema sin admins, revertimos ESTA (re-promote). GoTrue
    // no es transaccional, así que el pre-check + este post-check compensatorio es
    // la mitigación práctica (sin advisory locks sobre llamadas externas).
    if (patch.role === "editor") {
      const after = await listAllUsers(e.url, e.srk);
      if (after.filter((u) => u.role === "admin").length === 0) {
        // Re-promote (rollback). Si el rollback TAMBIÉN falla, avisamos al operador
        // que verifique a mano — no afirmamos "revertido" cuando no lo está.
        const reverted = await updateAuthUser(e.url, e.srk, id, { role: "admin" })
          .then(() => true)
          .catch(() => false);
        return NextResponse.json(
          reverted
            ? { error: "No se pudo degradar: dejaría el sistema sin admins (revertido)." }
            : {
                error:
                  "No se pudo degradar Y el rollback falló: el sistema puede haber quedado sin admins. Re-promové un usuario a admin manualmente.",
              },
          { status: reverted ? 409 : 500 }
        );
      }
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}

// DELETE — borra un usuario (admin-only).
export async function DELETE(
  _request: Request,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  const g = await requireAdmin();
  if ("res" in g) return g.res;
  const e = env();
  if (!e) return NextResponse.json({ error: "Supabase env not configured" }, { status: 503 });
  const { id } = params;

  if (id === g.user.id) {
    return NextResponse.json(
      { error: "No podés borrar tu propio usuario." },
      { status: 400 }
    );
  }

  try {
    const users = await listAllUsers(e.url, e.srk);
    const target = users.find((u) => u.id === id);
    const admins = users.filter((u) => u.role === "admin");
    if (target?.role === "admin" && admins.length <= 1) {
      return NextResponse.json(
        { error: "Es el único admin; no se puede borrar." },
        { status: 400 }
      );
    }
    await deleteAuthUser(e.url, e.srk, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 502 }
    );
  }
}

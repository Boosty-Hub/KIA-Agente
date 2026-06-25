"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Badge, Button, Modal, PasswordInput, EmptyState } from "@/components/ui";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Plus } from "@/components/ui/icons";
import { inputCls, labelCls, selectCls } from "@/components/ui/styles";
import { type AdminUser } from "@/lib/provision/admin";

type Role = "admin" | "editor";
const ROLE_LABEL: Record<Role, string> = { admin: "Admin", editor: "Editor" };

function fmtDate(s: string | null): string {
  if (!s) return "—";
  try {
    return new Date(s).toLocaleDateString("es", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return "—";
  }
}

export default function UsersClient({
  initialUsers,
  currentUserId,
  loadError,
}: {
  initialUsers: AdminUser[];
  currentUserId: string;
  loadError: string | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Crear
  const [createOpen, setCreateOpen] = useState(false);
  const [cEmail, setCEmail] = useState("");
  const [cPassword, setCPassword] = useState("");
  const [cRole, setCRole] = useState<Role>("editor");
  const [cErrors, setCErrors] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);

  // Resetear contraseña
  const [pwUser, setPwUser] = useState<AdminUser | null>(null);
  const [newPw, setNewPw] = useState("");
  const [pwSaving, setPwSaving] = useState(false);
  const [pwError, setPwError] = useState<string | null>(null);

  // Borrar
  const [delUser, setDelUser] = useState<AdminUser | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCErrors({});
    setError(null);
    setCreating(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: cEmail.trim(), password: cPassword, role: cRole }),
      });
      const j = await res.json().catch(() => ({}));
      if (res.status === 400 && j.fieldErrors) {
        setCErrors(j.fieldErrors);
        return;
      }
      if (!res.ok || !j.ok) {
        setError(j.error || `No se pudo crear (HTTP ${res.status})`);
        return;
      }
      setCreateOpen(false);
      setCEmail("");
      setCPassword("");
      setCRole("editor");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  async function handleRoleChange(u: AdminUser, role: Role) {
    if (role === u.role) return;
    setError(null);
    setBusyId(u.id);
    try {
      const res = await fetch(`/api/users/${u.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setError(j.error || (j.fieldErrors ? "Datos inválidos" : `Error (HTTP ${res.status})`));
        return;
      }
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  async function handleResetPw(e: React.FormEvent) {
    e.preventDefault();
    if (!pwUser) return;
    setPwError(null);
    if (newPw.length < 8) {
      setPwError("Mínimo 8 caracteres");
      return;
    }
    setPwSaving(true);
    try {
      const res = await fetch(`/api/users/${pwUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPw }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setPwError(j.error || (j.fieldErrors?.password ?? `Error (HTTP ${res.status})`));
        return;
      }
      setPwUser(null);
      setNewPw("");
    } catch (err) {
      setPwError(err instanceof Error ? err.message : String(err));
    } finally {
      setPwSaving(false);
    }
  }

  async function handleDelete() {
    if (!delUser) return;
    setError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/users/${delUser.id}`, { method: "DELETE" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok || !j.ok) {
        setError(j.error || `No se pudo borrar (HTTP ${res.status})`);
        return;
      }
      setDelUser(null);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-neutral-500">
          {initialUsers.length} {initialUsers.length === 1 ? "usuario" : "usuarios"}
        </p>
        <Button variant="primary" size="sm" leftIcon={<Plus size={14} />} onClick={() => setCreateOpen(true)}>
          Nuevo usuario
        </Button>
      </div>

      {loadError && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          No se pudieron cargar los usuarios: {loadError}
        </div>
      )}
      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      {initialUsers.length === 0 && !loadError ? (
        <EmptyState title="Sin usuarios" description="Creá el primer usuario del panel." />
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="bg-neutral-50/60 text-left">
                <tr>
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Email</th>
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Rol</th>
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Último ingreso</th>
                  <th className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {initialUsers.map((u) => {
                  const isSelf = u.id === currentUserId;
                  return (
                    <tr key={u.id}>
                      <td className="px-4 py-3 text-neutral-900">
                        {u.email ?? "—"}
                        {isSelf && <span className="ml-2 text-xs text-neutral-400">(vos)</span>}
                      </td>
                      <td className="px-4 py-3">
                        {isSelf ? (
                          <Badge color={u.role === "admin" ? "violet" : "neutral"}>{ROLE_LABEL[u.role]}</Badge>
                        ) : (
                          <select
                            value={u.role}
                            disabled={busyId === u.id}
                            onChange={(e) => handleRoleChange(u, e.target.value as Role)}
                            className={selectCls + " max-w-[130px] py-1.5"}
                            aria-label={`Rol de ${u.email ?? u.id}`}
                          >
                            <option value="admin">Admin</option>
                            <option value="editor">Editor</option>
                          </select>
                        )}
                      </td>
                      <td className="px-4 py-3 text-neutral-500">{fmtDate(u.last_sign_in_at)}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setPwUser(u);
                              setNewPw("");
                              setPwError(null);
                            }}
                          >
                            Resetear contraseña
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={isSelf}
                            title={isSelf ? "No podés borrarte a vos mismo" : "Borrar usuario"}
                            onClick={() => setDelUser(u)}
                            className="text-red-500 hover:text-red-700 hover:bg-red-50 disabled:opacity-40"
                          >
                            Borrar
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Crear usuario */}
      <Modal
        open={createOpen}
        title="Nuevo usuario"
        onClose={() => setCreateOpen(false)}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreateOpen(false)} disabled={creating}>
              Cancelar
            </Button>
            <Button variant="primary" busy={creating} onClick={handleCreate}>
              Crear
            </Button>
          </>
        }
      >
        <form onSubmit={handleCreate} className="space-y-4">
          <div className="space-y-1">
            <label className={labelCls} htmlFor="nu-email">Email</label>
            <input
              id="nu-email"
              type="email"
              value={cEmail}
              onChange={(e) => setCEmail(e.target.value)}
              placeholder="persona@empresa.com"
              className={inputCls}
              autoComplete="off"
            />
            {cErrors.email && <p className="text-xs text-red-600">{cErrors.email}</p>}
          </div>
          <div className="space-y-1">
            <label className={labelCls} htmlFor="nu-password">Contraseña</label>
            <PasswordInput
              id="nu-password"
              value={cPassword}
              onChange={(e) => setCPassword(e.target.value)}
              placeholder="Mínimo 8 caracteres"
              autoComplete="new-password"
            />
            {cErrors.password && <p className="text-xs text-red-600">{cErrors.password}</p>}
          </div>
          <div className="space-y-1">
            <label className={labelCls} htmlFor="nu-role">Rol</label>
            <select
              id="nu-role"
              value={cRole}
              onChange={(e) => setCRole(e.target.value as Role)}
              className={selectCls}
            >
              <option value="editor">Editor — opera (inbox, leads, novedades, vehículos, contenido, alertas)</option>
              <option value="admin">Admin — acceso total (+ gestión de usuarios)</option>
            </select>
            {cErrors.role && <p className="text-xs text-red-600">{cErrors.role}</p>}
          </div>
        </form>
      </Modal>

      {/* Resetear contraseña */}
      <Modal
        open={pwUser != null}
        title={`Resetear contraseña${pwUser?.email ? ` — ${pwUser.email}` : ""}`}
        onClose={() => setPwUser(null)}
        size="md"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPwUser(null)} disabled={pwSaving}>
              Cancelar
            </Button>
            <Button variant="primary" busy={pwSaving} onClick={handleResetPw}>
              Guardar
            </Button>
          </>
        }
      >
        <form onSubmit={handleResetPw} className="space-y-3">
          <div className="space-y-1">
            <label className={labelCls} htmlFor="rp-password">Nueva contraseña</label>
            <PasswordInput
              id="rp-password"
              value={newPw}
              onChange={(e) => setNewPw(e.target.value)}
              placeholder="Mínimo 8 caracteres"
              autoComplete="new-password"
            />
            {pwError && <p className="text-xs text-red-600">{pwError}</p>}
          </div>
        </form>
      </Modal>

      {/* Borrar */}
      <ConfirmDialog
        open={delUser != null}
        title="Borrar usuario"
        description={`Se eliminará el acceso de ${delUser?.email ?? "este usuario"}. Es irreversible.`}
        confirmLabel="Borrar"
        cancelLabel="Cancelar"
        tone="danger"
        busy={deleting}
        onCancel={() => setDelUser(null)}
        onConfirm={handleDelete}
      />
    </div>
  );
}

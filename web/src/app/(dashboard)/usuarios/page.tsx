import { redirect } from "next/navigation";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { roleFromUser } from "@/lib/auth/roles";
import { listAllUsers, type AdminUser } from "@/lib/provision/admin";
import { PageShell } from "@/components/ui";
import UsersClient from "./users-client";

export const dynamic = "force-dynamic";

export default async function UsuariosPage() {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  // Backstop server-side (además del middleware): solo admin entra acá.
  if (!user) redirect("/login");
  if (roleFromUser(user) !== "admin") redirect("/inbox");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const srk = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let users: AdminUser[] = [];
  let loadError: string | null = null;
  if (url && srk) {
    try {
      users = await listAllUsers(url, srk);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    }
  } else {
    loadError = "Supabase no está configurado en este entorno.";
  }

  return (
    <PageShell
      title="Usuarios"
      description="Quién entra al panel y con qué permisos. Los admin tienen acceso total; los editores solo operan (inbox, leads, novedades, vehículos, contenido y alertas)."
    >
      <UsersClient initialUsers={users} currentUserId={user.id} loadError={loadError} />
    </PageShell>
  );
}

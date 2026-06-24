import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValue } from "@/lib/runtime-config";
import { getBcvRateCached } from "@/lib/exchange";
import { MobileNav, SidebarNav } from "./nav";
import { UpdatesBanner } from "./updates-banner";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const [{ count: alertsCount }, { data: pubCfg }] = await Promise.all([
    supabase
      .from("alerts")
      .select("*", { count: "exact", head: true })
      .is("acknowledged_at", null),
    supabase
      .from("kommo_publish_config")
      .select("bcv_rate_enabled")
      .eq("is_active", true)
      .maybeSingle(),
  ]);

  const email = user?.email ?? "";
  const alerts = alertsCount ?? 0;
  // Resolve the branding label DB-first (editable from /agent) with env
  // fallback. Resolved server-side so it does NOT depend on the build-time
  // NEXT_PUBLIC_AGENT_LABEL inlining.
  const label = (await configValue("NEXT_PUBLIC_AGENT_LABEL")) || "Agente";

  // Tasa BCV: misma fuente + cache 6h que la tool del agente. Solo si la
  // capacidad está activa; si la fuente falla, simplemente no hay badge.
  const bcv = pubCfg?.bcv_rate_enabled === true ? await getBcvRateCached() : null;

  // Auto-update: ON salvo que el operador lo apague explícitamente ("0").
  const autoUpdate = (await configValue("AUTO_UPDATE_ENABLED")) !== "0";

  return (
    <div className="flex h-dvh overflow-hidden bg-neutral-50">
      <SidebarNav email={email} alertsCount={alerts} label={label} bcv={bcv ?? undefined} />
      <div className="flex min-w-0 flex-1 flex-col">
        <MobileNav email={email} alertsCount={alerts} label={label} bcv={bcv ?? undefined} />
        <UpdatesBanner autoUpdate={autoUpdate} />
        <main className="flex-1 min-w-0 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

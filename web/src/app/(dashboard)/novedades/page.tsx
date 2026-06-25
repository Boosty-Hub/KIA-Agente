import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageShell } from "@/components/ui";
import NovedadesClient from "./novedades-client";
import { type Promo } from "./promo-utils";

export const dynamic = "force-dynamic";

export default async function NovedadesPage() {
  const supabase = createSupabaseServerClient();
  const { data: rawPromos } = await supabase
    .from("promotions")
    .select("id,name,content,kind,starts_at,ends_at,weekdays,enabled")
    .order("created_at", { ascending: false });

  const promos = (rawPromos ?? []) as Promo[];

  return (
    <PageShell
      title="Novedades"
      description="Promos, eventos y situaciones transitorias que el agente debe conocer. Se inyectan en vivo según vigencia y on/off — no requieren redeploy."
    >
      <NovedadesClient promos={promos} />
    </PageShell>
  );
}

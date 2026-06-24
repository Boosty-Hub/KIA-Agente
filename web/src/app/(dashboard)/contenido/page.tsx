import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageShell } from "@/components/ui";
import ContentTabs from "./content-tabs";
import { type Promo } from "./promo-utils";

export const dynamic = "force-dynamic";

export default async function ContenidoPage({
  searchParams,
}: {
  searchParams: { tab?: string };
}) {
  const supabase = createSupabaseServerClient();

  const [{ data: rawSamples }, { data: rawDocs }, { data: rawPromos }] = await Promise.all([
    supabase
      .from("voice_samples")
      .select("id, type, title, metadata, ingested_at, created_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("kb_documents")
      .select("id, title, source_type, total_chunks, created_at")
      .order("created_at", { ascending: false }),
    supabase
      .from("promotions")
      .select("id,name,content,kind,starts_at,ends_at,weekdays,enabled")
      .order("created_at", { ascending: false }),
  ]);

  const samples = (rawSamples ?? []).map((s) => {
    const metadata = (s.metadata ?? {}) as Record<string, unknown>;
    return {
      id: s.id as string,
      type: s.type as string,
      title: s.title as string,
      chunkCount: Number(metadata.chunks_count ?? 0),
      ingestedAt: s.ingested_at as string | null,
    };
  });

  const docs = (rawDocs ?? []).map((d) => ({
    id: d.id as string,
    title: d.title as string,
    sourceType: d.source_type as string,
    totalChunks: (d.total_chunks as number) ?? 0,
    createdAt: d.created_at as string,
  }));

  const promos = (rawPromos ?? []) as Promo[];

  const rawTab = searchParams.tab;
  const initialTab: "voz" | "kb" | "promos" =
    rawTab === "kb" ? "kb" : rawTab === "promos" ? "promos" : "voz";

  return (
    <PageShell
      title="Contenido del agente"
      description="El material que moldea cómo responde el agente: su estilo de escritura y los hechos que puede consultar."
    >
      <ContentTabs initialTab={initialTab} samples={samples} docs={docs} promos={promos} />
    </PageShell>
  );
}

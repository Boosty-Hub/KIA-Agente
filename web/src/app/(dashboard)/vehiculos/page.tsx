import { createSupabaseServerClient } from "@/lib/supabase/server";
import { PageShell, EmptyState } from "@/components/ui";
import { VehicleRow, NewVehicleForm } from "./vehicle-editor";

export const dynamic = "force-dynamic";

export type Vehicle = {
  id: string;
  name: string;
  price_usd: number | null;
  description: string;
  enabled: boolean;
  sort_order: number;
};

export default async function VehiculosPage() {
  const supabase = createSupabaseServerClient();
  const { data: vehicles } = await supabase
    .from("vehicles")
    .select("id, name, price_usd, description, enabled, sort_order")
    .order("sort_order")
    .order("name");

  const list = (vehicles ?? []) as Vehicle[];
  const activeCount = list.filter((v) => v.enabled).length;

  return (
    <PageShell
      title="Vehículos"
      description="Catálogo del concesionario. El agente recibe estos modelos en vivo y SOLO responde sobre los vehículos activos — si preguntan por algo fuera del catálogo, lo deriva en lugar de inventar."
      actions={<NewVehicleForm />}
    >
      {list.length === 0 ? (
        <EmptyState
          title="Sin vehículos cargados"
          description="Agregá los modelos que comercializa el concesionario para que el agente pueda responder sobre ellos."
        />
      ) : (
        <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead className="sticky top-0 bg-neutral-50/60 text-left">
                <tr>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Modelo</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Precio (USD)</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Descripción</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Activo</th>
                  <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400 text-right"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {list.map((v) => (
                  <VehicleRow key={v.id} vehicle={v} />
                ))}
              </tbody>
            </table>
          </div>
          <div className="border-t border-neutral-100 px-4 py-2.5 text-xs text-neutral-500">
            {list.length} {list.length === 1 ? "vehículo" : "vehículos"} · {activeCount} {activeCount === 1 ? "activo" : "activos"}
          </div>
        </div>
      )}
    </PageShell>
  );
}

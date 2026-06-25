"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import PromoCard from "./promo-card";
import PromoFormModal from "./promo-form-modal";
import { SectionCard, EmptyState, Button } from "@/components/ui";
import { Sparkles, Plus } from "@/components/ui/icons";
import { type Promo } from "./promo-utils";

export default function NovedadesClient({ promos }: { promos: Promo[] }) {
  const router = useRouter();
  const [modal, setModal] = useState<{ open: boolean; editing: Promo | null }>({
    open: false,
    editing: null,
  });

  function openCreate() {
    setModal({ open: true, editing: null });
  }
  function openEdit(promo: Promo) {
    setModal({ open: true, editing: promo });
  }
  function closeModal() {
    setModal({ open: false, editing: null });
  }

  async function handleToggle(id: string, next: boolean) {
    await fetch(`/api/promotions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: next }),
    });
    router.refresh();
  }

  async function handleDelete(id: string) {
    await fetch(`/api/promotions/${id}`, { method: "DELETE" });
    router.refresh();
  }

  return (
    <div className="space-y-6">
      <SectionCard
        icon={<Sparkles size={18} />}
        title="Crear novedad"
        description="Contexto transitorio que el agente conoce en vivo: promos, eventos y situaciones operativas."
        action={
          <Button variant="primary" size="sm" leftIcon={<Plus size={14} />} onClick={openCreate}>
            Nueva
          </Button>
        }
      >
        <p className="text-xs text-neutral-500">
          Se inyectan automáticamente en el contexto del agente según su vigencia (fechas o días de la
          semana) y su estado on/off. Las <span className="font-medium text-amber-700">situaciones</span> son
          restricciones operativas: el agente las respeta siempre (ej: «hoy cerrado») y avisa con naturalidad,
          en lugar de ofrecerlas como una promo.
        </p>
      </SectionCard>

      {promos.length === 0 ? (
        <EmptyState
          icon={<Sparkles size={24} />}
          title="Sin novedades"
          description="Creá la primera promo, evento o situación para que el agente la tenga en cuenta."
          action={
            <Button variant="primary" size="sm" leftIcon={<Plus size={14} />} onClick={openCreate}>
              Crear primera novedad
            </Button>
          }
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {promos.map((promo) => (
            <PromoCard
              key={promo.id}
              promo={promo}
              onToggle={handleToggle}
              onEdit={openEdit}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}

      <PromoFormModal
        key={modal.editing?.id ?? "new"}
        open={modal.open}
        initial={modal.editing}
        onClose={closeModal}
        onSaved={() => {
          closeModal();
          router.refresh();
        }}
      />
    </div>
  );
}

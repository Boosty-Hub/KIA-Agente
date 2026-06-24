"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import VoiceUploader from "./voice-uploader";
import SampleRow from "./sample-row";
import KBUploader from "./kb-uploader";
import DocumentRow from "./document-row";
import PromoCard from "./promo-card";
import PromoFormModal from "./promo-form-modal";
import { SectionCard, EmptyState, Button } from "@/components/ui";
import { Sparkles, Plus } from "@/components/ui/icons";
import { type Promo } from "./promo-utils";

type Tab = "voz" | "kb" | "promos";

type VoiceSample = {
  id: string;
  type: string;
  title: string;
  chunkCount: number;
  ingestedAt: string | null;
};

type KBDocument = {
  id: string;
  title: string;
  sourceType: string;
  totalChunks: number;
  createdAt: string;
};

export default function ContentTabs({
  initialTab,
  samples,
  docs,
  promos,
}: {
  initialTab: Tab;
  samples: VoiceSample[];
  docs: KBDocument[];
  promos: Promo[];
}) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const router = useRouter();

  // Promo modal state
  const [promoModal, setPromoModal] = useState<{ open: boolean; editing: Promo | null }>({
    open: false,
    editing: null,
  });

  function openCreate() {
    setPromoModal({ open: true, editing: null });
  }

  function openEdit(promo: Promo) {
    setPromoModal({ open: true, editing: promo });
  }

  function closeModal() {
    setPromoModal({ open: false, editing: null });
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

  const tabs: { key: Tab; label: string }[] = [
    { key: "voz", label: "Estilo de voz" },
    { key: "kb", label: "Base de conocimiento" },
    { key: "promos", label: "Promos y eventos" },
  ];

  return (
    <div className="space-y-6">
      {/* Segmented control tabs */}
      <div className="flex flex-wrap gap-1 rounded-lg bg-neutral-100 p-1">
        {tabs.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={
              "px-3 py-1.5 text-sm font-medium rounded-md transition-colors " +
              (tab === key
                ? "bg-white text-neutral-900 shadow-sm"
                : "text-neutral-600 hover:text-neutral-900")
            }
          >
            {label}
          </button>
        ))}
      </div>

      {/* Tab: Estilo de voz */}
      {tab === "voz" && (
        <div className="space-y-6">
          <p className="text-sm text-neutral-600">
            Ejemplos de cómo habla tu operador: exports de chats, transcripciones, reglas de tono y respuestas modelo.
            El agente los lee en{" "}
            <span className="font-semibold text-neutral-900">CADA respuesta</span> para imitar el estilo.
          </p>

          <VoiceUploader />

          <section className="space-y-3">
            <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
              Samples ingeridos ({samples.length})
            </h2>
            {samples.length > 0 ? (
              <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[640px]">
                    <thead className="sticky top-0 bg-neutral-50/60 text-left">
                      <tr>
                        <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Tipo</th>
                        <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Título</th>
                        <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Chunks</th>
                        <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Ingerido</th>
                        <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400 text-right">Acciones</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {samples.map((s) => (
                        <SampleRow
                          key={s.id}
                          id={s.id}
                          type={s.type}
                          title={s.title}
                          chunkCount={s.chunkCount}
                          ingestedAt={s.ingestedAt}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-neutral-200 bg-white p-8 text-center shadow-card">
                <p className="text-sm text-neutral-600">
                  Todavía no has cargado nada. Empieza por una regla corta describiendo tu voz.
                </p>
              </div>
            )}
          </section>
        </div>
      )}

      {/* Tab: Base de conocimiento */}
      {tab === "kb" && (
        <div className="space-y-6">
          <p className="text-sm text-neutral-600">
            Datos y documentos que el agente consulta cuando necesita un hecho: precios, fechas, condiciones, FAQs.
            Se busca{" "}
            <span className="font-semibold text-neutral-900">on-demand</span> (no se lee entero en cada respuesta).
          </p>

          <KBUploader />

          <section className="space-y-3">
            <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
              Documentos indexados ({docs.length})
            </h2>
            {docs.length > 0 ? (
              <div className="overflow-hidden rounded-xl border border-neutral-200 bg-white shadow-card">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[640px]">
                    <thead className="sticky top-0 bg-neutral-50/60 text-left">
                      <tr>
                        <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Formato</th>
                        <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Título</th>
                        <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Chunks</th>
                        <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400">Subido</th>
                        <th scope="col" className="px-4 py-2.5 text-[11px] font-medium uppercase tracking-wider text-neutral-400 text-right">Acciones</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-neutral-100">
                      {docs.map((d) => (
                        <DocumentRow
                          key={d.id}
                          id={d.id}
                          title={d.title}
                          sourceType={d.sourceType}
                          totalChunks={d.totalChunks}
                          createdAt={d.createdAt}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div className="rounded-xl border border-neutral-200 bg-white p-8 text-center shadow-card">
                <p className="text-sm text-neutral-600">
                  Vacía. Empieza subiendo un PDF de un curso o una FAQ corta en markdown.
                </p>
              </div>
            )}
          </section>
        </div>
      )}

      {/* Tab: Promos y eventos */}
      {tab === "promos" && (
        <div className="space-y-6">
          <SectionCard
            icon={<Sparkles size={18} />}
            title="Crear promo o evento"
            description="El agente mencionará las promos activas en cada respuesta cuando sean relevantes."
            action={
              <Button variant="primary" size="sm" leftIcon={<Plus size={14} />} onClick={openCreate}>
                Nueva
              </Button>
            }
          >
            <p className="text-xs text-neutral-500">
              Las promos activas se inyectan automáticamente en el contexto del agente. Podés activar/desactivar
              cada una sin borrarla, y fijar fechas o días de la semana para que apliquen solo cuando corresponde.
            </p>
          </SectionCard>

          {promos.length === 0 ? (
            <EmptyState
              icon={<Sparkles size={24} />}
              title="Sin promos ni eventos"
              description="Creá la primera promo para que el agente empiece a mencionarla en sus respuestas."
              action={
                <Button variant="primary" size="sm" leftIcon={<Plus size={14} />} onClick={openCreate}>
                  Crear primera promo
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
        </div>
      )}

      {/* Promo form modal (shared across create/edit) */}
      <PromoFormModal
        key={promoModal.editing?.id ?? "new"}
        open={promoModal.open}
        initial={promoModal.editing}
        onClose={closeModal}
        onSaved={() => {
          closeModal();
          router.refresh();
        }}
      />
    </div>
  );
}

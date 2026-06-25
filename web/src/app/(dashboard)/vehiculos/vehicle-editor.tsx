"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Modal, Button, ConfirmDialog, inputCls } from "@/components/ui";
import type { Vehicle } from "./page";

function formatPrice(price: number | null): string {
  if (price === null) return "Consultar";
  return "$" + price.toLocaleString("en-US");
}

export function VehicleRow({ vehicle }: { vehicle: Vehicle }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  async function toggleEnabled() {
    await fetch(`/api/vehiculos/${vehicle.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: !vehicle.enabled }),
    });
    router.refresh();
  }

  return (
    <>
      <tr
        className="cursor-pointer transition-colors hover:bg-neutral-50"
        onClick={() => setOpen(true)}
      >
        <td className="px-4 py-3 font-medium text-neutral-900">{vehicle.name}</td>
        <td className="px-4 py-3 tabular-nums text-neutral-700">{formatPrice(vehicle.price_usd)}</td>
        <td className="px-4 py-3 text-neutral-500">
          <span className="block max-w-[420px] truncate">{vehicle.description}</span>
        </td>
        <td className="px-4 py-3">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleEnabled();
            }}
            title={vehicle.enabled ? "Visible para el agente" : "Oculto: el agente no lo ofrece"}
            className={
              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors " +
              (vehicle.enabled
                ? "bg-emerald-100 text-emerald-700 hover:bg-emerald-200"
                : "bg-neutral-100 text-neutral-600 hover:bg-neutral-200")
            }
          >
            {vehicle.enabled ? "ON" : "OFF"}
          </button>
        </td>
        <td className="px-4 py-3 text-right">
          <span className="text-xs font-medium text-neutral-500">Ver / Editar →</span>
        </td>
      </tr>
      {open && (
        <Modal
          open={open}
          title={vehicle.name}
          subtitle={formatPrice(vehicle.price_usd)}
          onClose={() => setOpen(false)}
        >
          <VehicleForm
            vehicle={vehicle}
            onDone={() => {
              setOpen(false);
              router.refresh();
            }}
          />
        </Modal>
      )}
    </>
  );
}

function VehicleForm({ vehicle, onDone }: { vehicle: Vehicle; onDone: () => void }) {
  const [name, setName] = useState(vehicle.name);
  const [price, setPrice] = useState(vehicle.price_usd === null ? "" : String(vehicle.price_usd));
  const [description, setDescription] = useState(vehicle.description);
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/vehiculos/${vehicle.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, price_usd: price, description }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "error");
      return;
    }
    onDone();
  }

  async function remove() {
    setDeleting(true);
    await fetch(`/api/vehiculos/${vehicle.id}`, { method: "DELETE" });
    setDeleting(false);
    setConfirmingDelete(false);
    onDone();
  }

  return (
    <form onSubmit={save} className="space-y-4 max-w-2xl">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">Modelo</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-neutral-600">Precio USD (vacío = consultar)</label>
          <input
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            inputMode="numeric"
            placeholder="47522"
            className={`${inputCls} tabular-nums`}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <label className="text-xs font-medium text-neutral-600">Descripción y equipamiento</label>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={6}
          className={`${inputCls} min-h-[6rem] resize-y`}
        />
      </div>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" variant="primary" busy={busy} disabled={busy}>
          Guardar
        </Button>
        <Button type="button" variant="danger" onClick={() => setConfirmingDelete(true)}>
          Borrar
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancelar
        </Button>
      </div>
      <ConfirmDialog
        open={confirmingDelete}
        title={`Borrar "${vehicle.name}"`}
        description="El agente dejará de ofrecer este vehículo. Esta acción no se puede deshacer."
        confirmLabel="Borrar"
        tone="danger"
        busy={deleting}
        onConfirm={remove}
        onCancel={() => setConfirmingDelete(false)}
      />
    </form>
  );
}

export function NewVehicleForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function resetState() {
    setName(""); setPrice(""); setDescription(""); setError(null);
  }

  function close() {
    setOpen(false);
    resetState();
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/vehiculos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, price_usd: price, description }),
    });
    setBusy(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j.error ?? "error");
      return;
    }
    close();
    router.refresh();
  }

  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        + Nuevo vehículo
      </Button>

      <Modal
        open={open}
        title="Nuevo vehículo"
        onClose={close}
        size="xl"
        footer={
          <>
            <Button type="button" variant="secondary" onClick={close}>
              Cancelar
            </Button>
            <Button type="submit" form="new-vehicle-form" variant="primary" busy={busy} disabled={busy}>
              Crear
            </Button>
          </>
        }
      >
        <form id="new-vehicle-form" onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-600">Modelo</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Kia Sportage"
                className={inputCls}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-neutral-600">Precio USD (vacío = consultar)</label>
              <input
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                inputMode="numeric"
                placeholder="47522"
                className={`${inputCls} tabular-nums`}
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-neutral-600">Descripción y equipamiento</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={6}
              placeholder="SUV con motor 2.0L (154 hp), tracción AWD…"
              className={`${inputCls} min-h-[6rem] resize-y`}
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </form>
      </Modal>
    </>
  );
}

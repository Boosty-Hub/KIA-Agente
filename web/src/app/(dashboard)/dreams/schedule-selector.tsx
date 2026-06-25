"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Switch } from "@/components/ui";

const FREQ_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "Todos los días" },
  { value: 2, label: "Cada 2 días" },
  { value: 3, label: "Cada 3 días" },
  { value: 7, label: "Cada 7 días" },
  { value: 14, label: "Cada 14 días" },
  { value: 30, label: "Cada 30 días" },
];

export default function ScheduleSelector({
  initialEnabled,
  initialEveryDays,
}: {
  initialEnabled: boolean;
  initialEveryDays: number;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(initialEnabled);
  const [everyDays, setEveryDays] = useState(initialEveryDays);
  const [busy, setBusy] = useState(false);

  async function save(patch: { enabled?: boolean; everyDays?: number }) {
    const prevEnabled = enabled;
    const prevEvery = everyDays;
    if (patch.enabled !== undefined) setEnabled(patch.enabled);
    if (patch.everyDays !== undefined) setEveryDays(patch.everyDays);
    setBusy(true);
    try {
      const res = await fetch("/api/dreams/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      router.refresh();
    } catch {
      setEnabled(prevEnabled);
      setEveryDays(prevEvery);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-neutral-200 bg-white px-3 py-2 shadow-sm sm:flex-row sm:items-center sm:gap-4">
      <div className="flex items-center gap-2">
        <Switch
          checked={enabled}
          disabled={busy}
          onChange={(v) => save({ enabled: v })}
          tone="emerald"
          aria-label="Activar Dreams"
        />
        <span className="text-xs font-medium text-neutral-700">
          {enabled ? "Dreams activado" : "Dreams apagado"}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <label className="text-xs text-neutral-500">Frecuencia del análisis diario</label>
        <select
          value={everyDays}
          disabled={busy || !enabled}
          onChange={(e) => save({ everyDays: Number(e.target.value) })}
          className="rounded-lg border border-neutral-300 bg-white px-2.5 py-1.5 text-sm text-neutral-800 focus:border-neutral-900 focus:outline-none focus:ring-1 focus:ring-neutral-900 disabled:opacity-50"
        >
          {FREQ_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

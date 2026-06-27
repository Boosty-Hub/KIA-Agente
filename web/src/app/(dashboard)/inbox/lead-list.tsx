"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui";
import { timeAgo } from "@/lib/time-ago";
import ChannelIcon from "./channel-icon";

export type LeadListItem = {
  id: string;
  display_name: string | null;
  channel: string | null;
  kommo_lead_id: number | null;
  last_message_at: string | null;
  lastMsg: { content: string; direction: string; vertical: string | null } | null;
  hasReviewPending: boolean;
};

// Cuántas filas se muestran al inicio y cuántas se agregan en cada scroll.
const PAGE = 50;

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

// Lista de conversaciones con carga progresiva: renderiza PAGE filas y va
// revelando más a medida que el usuario hace scroll hacia abajo (Intersection
// Observer sobre un centinela al final). Los datos ya llegan completos del
// server (hasta 500); esto solo evita pintar 500 filas de una.
export default function LeadList({
  leads,
  selectedLead,
  filterQS,
}: {
  leads: LeadListItem[];
  selectedLead: string | null;
  filterQS: string;
}) {
  const [visible, setVisible] = useState(PAGE);
  const sentinelRef = useRef<HTMLLIElement | null>(null);

  // Reset al cambiar el set de leads (filtros, realtime refresh).
  const signature = useMemo(
    () => `${leads.length}:${leads[0]?.id ?? ""}`,
    [leads]
  );
  useEffect(() => {
    setVisible(PAGE);
  }, [signature]);

  useEffect(() => {
    if (visible >= leads.length) return;
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible((v) => Math.min(v + PAGE, leads.length));
        }
      },
      { rootMargin: "400px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible, leads.length]);

  if (leads.length === 0) {
    return <p className="p-5 text-sm text-neutral-500">Sin conversaciones todavía.</p>;
  }

  const shown = leads.slice(0, visible);

  return (
    <ul className="divide-y divide-neutral-100">
      {shown.map((l) => {
        const name = l.display_name ?? `Lead ${l.kommo_lead_id ?? "?"}`;
        const active = selectedLead === l.id;
        return (
          <li key={l.id}>
            <Link
              href={`/inbox?lead=${l.id}${filterQS ? `&${filterQS}` : ""}`}
              className={
                "block px-4 py-3 transition-colors " +
                (active ? "bg-brand-soft" : "hover:bg-neutral-50")
              }
            >
              <div className="flex items-start gap-3">
                <div
                  className={
                    "flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold " +
                    (active ? "bg-brand text-brand-foreground" : "bg-neutral-100 text-neutral-600")
                  }
                >
                  {initials(name)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p
                      className={
                        "truncate text-sm font-medium " +
                        (active ? "text-brand-strong" : "text-neutral-900")
                      }
                    >
                      {name}
                    </p>
                    <span className="shrink-0 text-[11px] text-neutral-400">
                      {l.last_message_at ? timeAgo(l.last_message_at) : "—"}
                    </span>
                  </div>
                  {l.lastMsg && (
                    <p className="mt-0.5 truncate text-xs text-neutral-500">
                      {l.lastMsg.direction === "outbound" ? "→ " : ""}
                      {l.lastMsg.content}
                    </p>
                  )}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {l.channel && (
                      <ChannelIcon channel={l.channel} size={16} className="shrink-0" />
                    )}
                    {l.lastMsg?.vertical && <Badge color="blue">{l.lastMsg.vertical}</Badge>}
                    {l.hasReviewPending && <Badge color="amber">revisión</Badge>}
                  </div>
                </div>
              </div>
            </Link>
          </li>
        );
      })}
      {visible < leads.length && (
        <li ref={sentinelRef} className="px-4 py-4 text-center text-xs text-neutral-400">
          Cargando más conversaciones…
        </li>
      )}
    </ul>
  );
}

"use client";

import { useEffect, useState } from "react";
import type { ProvisionStatus } from "@/app/api/provision/status/route";

/**
 * Non-blocking banner shown on /setup when the DB or Edge Functions are not
 * fully initialized. Fetches /api/provision/status client-side so it does not
 * block the page render and does not require any service client.
 */
export function InitBanner() {
  const [status, setStatus] = useState<ProvisionStatus | null>(null);

  useEffect(() => {
    fetch("/api/provision/status")
      .then((r) => r.json())
      .then((data: ProvisionStatus) => setStatus(data))
      .catch(() => null); // silently ignore — banner is non-blocking
  }, []);

  if (!status) return null;

  const incomplete =
    !status.dbInitialized ||
    status.migrationsApplied.pending.length > 0 ||
    status.functionsDeployed.missing.length > 0;

  if (!incomplete) return null;

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 flex items-start gap-3">
      <svg
        className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500"
        viewBox="0 0 16 16"
        fill="none"
        aria-hidden
      >
        <path
          d="M8 1.5L1 14h14L8 1.5z"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinejoin="round"
        />
        <path
          d="M8 6v3.5M8 11.5v.5"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      <div className="space-y-0.5">
        <p className="font-medium">Inicialización incompleta</p>
        <p className="text-xs text-amber-700">
          {status.migrationsApplied.pending.length > 0 && (
            <>
              Migraciones pendientes:{" "}
              {status.migrationsApplied.pending.length}.{" "}
            </>
          )}
          {status.functionsDeployed.missing.length > 0 && (
            <>
              Edge Functions sin desplegar:{" "}
              {status.functionsDeployed.missing.length}.{" "}
            </>
          )}
          <a
            href="/first-run"
            className="font-medium underline underline-offset-2"
          >
            Completá la configuración inicial
          </a>
          .
        </p>
      </div>
    </div>
  );
}

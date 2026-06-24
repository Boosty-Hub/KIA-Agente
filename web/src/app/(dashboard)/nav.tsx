"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  Menu, X, Inbox, Users, Layers, Target, Sparkles, Stars,
  Bot, Wrench, Repeat, Bell, Settings, LogOut, BarChart3,
} from "@/components/ui";
import { BcvBanner } from "./bcv-banner";

type BcvData = { rate: number; source: string; fetchedAt: string };

const ENV_AGENT_LABEL = process.env.NEXT_PUBLIC_AGENT_LABEL || "Agente";

type NavItem = {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

// Grupos de sección (NO cambia rutas).
const NAV_GROUPS: NavGroup[] = [
  {
    label: "Operación",
    items: [
      { href: "/inbox", label: "Inbox", icon: Inbox },
      { href: "/leads", label: "Leads", icon: Users },
    ],
  },
  {
    label: "Contenido y calidad",
    items: [
      { href: "/contenido", label: "Contenido", icon: Layers },
      { href: "/verticales", label: "Verticales", icon: Target },
      { href: "/outcomes", label: "Outcomes", icon: Sparkles },
      { href: "/consumo", label: "Consumo", icon: BarChart3 },
      { href: "/dreams", label: "Dreams", icon: Stars },
    ],
  },
  {
    label: "Configuración",
    items: [
      { href: "/agent", label: "Agente", icon: Bot },
      { href: "/tools", label: "Tools", icon: Wrench },
      { href: "/seguimiento", label: "Seguimiento", icon: Repeat },
      { href: "/alerts", label: "Alertas", icon: Bell },
      { href: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

function NavItemLink({
  item,
  pathname,
  alertsCount,
  onNavigate,
}: {
  item: NavItem;
  pathname: string;
  alertsCount: number;
  onNavigate?: () => void;
}) {
  const active = pathname === item.href || pathname.startsWith(item.href + "/");
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      className={`group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
        active
          ? "bg-brand-soft font-medium text-brand-strong"
          : "text-neutral-600 hover:bg-neutral-100 hover:text-neutral-900"
      }`}
    >
      {/* Barra izquierda activa */}
      {active && (
        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-full bg-brand" />
      )}
      <Icon
        size={17}
        className={active ? "text-brand" : "text-neutral-400 group-hover:text-neutral-600"}
      />
      <span className="flex-1">{item.label}</span>
      {item.href === "/alerts" && alertsCount > 0 && (
        <span
          className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${
            active ? "bg-white text-brand-strong" : "bg-red-500 text-white"
          }`}
        >
          {alertsCount}
        </span>
      )}
    </Link>
  );
}

function NavGroups({
  alertsCount,
  onNavigate,
}: {
  alertsCount: number;
  onNavigate?: () => void;
}) {
  const pathname = usePathname();
  return (
    <nav className="flex-1 overflow-y-auto px-3 py-2">
      {NAV_GROUPS.map((group) => (
        <div key={group.label}>
          <p className="px-3 pb-1.5 pt-5 text-[11px] font-semibold uppercase tracking-wider text-neutral-400">
            {group.label}
          </p>
          <div className="space-y-0.5">
            {group.items.map((item) => (
              <NavItemLink
                key={item.href}
                item={item}
                pathname={pathname}
                alertsCount={alertsCount}
                onNavigate={onNavigate}
              />
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}

function NavFooter({
  email,
  onNavigate,
}: {
  email: string;
  onNavigate?: () => void;
}) {
  // Inicial del email para el avatar
  const initial = (email || "U").charAt(0).toUpperCase();

  return (
    <div className="border-t border-neutral-200/80 p-3">
      <div className="flex items-center gap-2.5">
        {/* Avatar inicial */}
        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-neutral-100 text-xs font-medium text-neutral-600">
          {initial}
        </div>
        {/* Email truncado */}
        <span className="min-w-0 flex-1 truncate text-xs text-neutral-600" title={email}>
          {email}
        </span>
        {/* Botón logout solo-ícono */}
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            onClick={onNavigate}
            aria-label="Cerrar sesión"
            className="grid h-8 w-8 place-items-center rounded-lg text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <LogOut size={16} />
          </button>
        </form>
      </div>
    </div>
  );
}

export function SidebarNav({
  email,
  alertsCount,
  label,
  bcv,
}: {
  email: string;
  alertsCount: number;
  label?: string;
  bcv?: BcvData;
}) {
  const agentLabel = label || ENV_AGENT_LABEL;
  const initial = agentLabel.charAt(0).toUpperCase();

  return (
    <aside className="hidden w-60 flex-col border-r border-neutral-200/80 bg-white lg:flex">
      {/* Header de marca */}
      <div className="flex items-center gap-2.5 border-b border-neutral-200/80 px-4 py-4">
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground text-sm font-semibold">
          {initial}
        </div>
        <p className="min-w-0 truncate font-semibold tracking-tight text-neutral-900">
          {agentLabel}
        </p>
      </div>

      <NavGroups alertsCount={alertsCount} />

      {/* Pill BCV compacto sobre el footer de usuario */}
      {bcv && (
        <div className="border-t border-neutral-200/80 px-3 py-2">
          <BcvBanner rate={bcv.rate} source={bcv.source} fetchedAt={bcv.fetchedAt} variant="sidebar" />
        </div>
      )}

      <NavFooter email={email} />
    </aside>
  );
}

export function MobileNav({
  email,
  alertsCount,
  label,
  bcv,
}: {
  email: string;
  alertsCount: number;
  label?: string;
  bcv?: BcvData;
}) {
  const [open, setOpen] = useState(false);
  const agentLabel = label || ENV_AGENT_LABEL;
  const initial = agentLabel.charAt(0).toUpperCase();

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 items-center justify-between border-b border-neutral-200 bg-white px-4 lg:hidden">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand text-brand-foreground text-xs font-semibold">
            {initial}
          </div>
          <p className="font-semibold tracking-tight text-neutral-900">{agentLabel}</p>
        </div>
        <div className="flex items-center gap-2">
          {bcv && (
            <BcvBanner rate={bcv.rate} source={bcv.source} fetchedAt={bcv.fetchedAt} variant="mini" />
          )}
          <button
            type="button"
            aria-label="Abrir menú"
            onClick={() => setOpen(true)}
            className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-neutral-200 text-neutral-700 transition-colors hover:bg-neutral-50"
          >
            <Menu size={18} />
          </button>
        </div>
      </header>

      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-0 flex h-full w-72 flex-col bg-white shadow-modal">
            {/* Header de marca (drawer) */}
            <div className="flex items-center justify-between border-b border-neutral-200/80 px-4 py-4">
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand text-brand-foreground text-sm font-semibold">
                  {initial}
                </div>
                <p className="min-w-0 truncate font-semibold tracking-tight text-neutral-900">
                  {agentLabel}
                </p>
              </div>
              <button
                type="button"
                aria-label="Cerrar menú"
                onClick={() => setOpen(false)}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-neutral-500 transition-colors hover:bg-neutral-100"
              >
                <X size={18} />
              </button>
            </div>
            <NavGroups
              alertsCount={alertsCount}
              onNavigate={() => setOpen(false)}
            />
            <NavFooter email={email} onNavigate={() => setOpen(false)} />
          </div>
        </div>
      )}
    </>
  );
}

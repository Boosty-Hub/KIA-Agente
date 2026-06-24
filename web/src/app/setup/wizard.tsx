"use client";

import { useState } from "react";
import { AgentPromptAssistant } from "@/components/agent-prompt-assistant";
import { KommoWebhookPanel } from "@/components/kommo-webhook-panel";
import { VerticalsAssistant } from "@/components/verticals-assistant";
import { Button } from "@/components/ui/button";
import { inputCls, labelCls } from "@/components/ui/styles";

type StepStatus = "idle" | "running" | "done" | "error";

type Prefill = {
  operatorName: string;
  agentName: string;
  agentLabel: string;
  agentEnvironmentName: string;
  agentModel: string;
  masterStoreName: string;
  leadsStoreName: string;
  subdomain: string;
  apiDomain: string;
};

type Provisioned = {
  masterId: string | null;
  leadsId: string | null;
  environmentId: string | null;
  agentId: string | null;
  agentVersion: string | null;
};

export type SetupState = {
  credentialsDone: boolean;
  memoryDone: boolean;
  agentDone: boolean;
  kommoDone: boolean;
  hasSystemPrompt: boolean;
  prefill: Prefill;
  provisioned: Provisioned;
};

// ─── Step definitions ────────────────────────────────────────────────────────
// Step 0 = Supabase (always done — shown for continuity only)
// Step 1 = Anthropic (API key)
// Step 2 = Agente (identity + system prompt + provision)
// Step 3 = Verticales (AI suggests message categories from the agent)
// Step 4 = Memoria (memory stores)
// Step 5 = Kommo (long-lived token)
// Step 6 = Done

const STEPS = [
  { key: "supabase", label: "Base de datos" },
  { key: "anthropic", label: "Conectá Anthropic" },
  { key: "agente", label: "Creá tu agente" },
  { key: "verticales", label: "Verticales" },
  { key: "memoria", label: "Memoria y aprendizaje" },
  { key: "kommo", label: "Conectá Kommo" },
  { key: "done", label: "¡Listo!" },
] as const;

type StepKey = (typeof STEPS)[number]["key"];

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Convert any string to a lowercase kebab-case slug for deriving technical names */
function toSlug(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Derive the four technical names from a user-visible slug */
function deriveNames(slug: string) {
  const base = slug || "agente";
  return {
    agentName: `${base}-agent`,
    agentEnvironmentName: `${base}-env`,
    masterStoreName: `${base}-master`,
    leadsStoreName: `${base}-leads`,
  };
}

// Extract a clean Kommo subdomain from whatever the user types: "miempresa",
// "miempresa.kommo.com", or "https://miempresa.kommo.com/leads/…".
function parseKommoSubdomain(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .split("/")[0]
    .replace(/\.(kommo\.com|amocrm\.(com|ru))$/i, "")
    .replace(/\.(kommo\.com|amocrm\.(com|ru))(?=[:/])/i, "")
    .trim();
}


// ─── Design tokens ───────────────────────────────────────────────────────────
// inputCls, labelCls → imported from @/components/ui/styles
// Button (primary/secondary/ghost/danger) → imported from @/components/ui/button
const hintCls = "text-xs text-neutral-500";

// ─── Sub-components ──────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: StepStatus | "completed" }) {
  const map: Record<StepStatus | "completed", [string, string]> = {
    idle: ["bg-neutral-200 text-neutral-600", "Pendiente"],
    running: ["bg-blue-100 text-blue-700", "Corriendo…"],
    done: ["bg-emerald-100 text-emerald-700", "Listo"],
    completed: ["bg-emerald-100 text-emerald-700", "Completado"],
    error: ["bg-red-100 text-red-700", "Error"],
  };
  const [cls, text] = map[status];
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {text}
    </span>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
      {message}
    </p>
  );
}

// Numbered instruction list for non-technical guidance
function Steps({ items }: { items: string[] }) {
  return (
    <ol className="space-y-2">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 text-xs text-neutral-600">
          <span className="flex-shrink-0 flex h-5 w-5 items-center justify-center rounded-full bg-neutral-100 text-[10px] font-semibold text-neutral-700">
            {i + 1}
          </span>
          <span className="leading-relaxed">{item}</span>
        </li>
      ))}
    </ol>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function SetupWizard({ state }: { state: SetupState }) {
  // Map the existing done-flags onto the new step order:
  // anthropicDone = credentialsDone (key was saved in step 1 of old wizard)
  // agenteDone    = agentDone
  // memoriaDone   = memoryDone
  // kommoDone     = kommoDone
  const anthropicDone = state.credentialsDone;
  const agenteDone = state.agentDone;
  const memoriaDone = state.memoryDone;
  const kommoDone = state.kommoDone;

  // Open the first incomplete step (supabase is always done → skip to step 1+).
  // Verticales (step 3) is optional and has no persisted flag: when the agent is
  // done but memory isn't, we land on Verticales so it's never silently skipped.
  const [step, setStep] = useState<number>(() => {
    if (!anthropicDone) return 1;
    if (!agenteDone) return 2;
    if (!memoriaDone) return 3; // → Verticales, then continue to Memoria
    if (!kommoDone) return 5;
    return 6;
  });

  const [statuses, setStatuses] = useState<Record<string, StepStatus>>({
    anthropic: anthropicDone ? "done" : "idle",
    agente: agenteDone ? "done" : "idle",
    verticales: "idle",
    memoria: memoriaDone ? "done" : "idle",
    kommo: kommoDone ? "done" : "idle",
  });

  const [errors, setErrors] = useState<Record<string, string | null>>({});
  const [provisioned, setProvisioned] = useState<Provisioned>(state.provisioned);

  // ── Form: Anthropic key ──
  const [anthropicApiKey, setAnthropicApiKey] = useState("");

  // ── Form: Agente ──
  // Derive initial slug from prefill values if available
  const initialSlug = (() => {
    if (state.prefill.agentLabel) return toSlug(state.prefill.agentLabel);
    if (state.prefill.operatorName) return toSlug(state.prefill.operatorName);
    return "";
  })();


  const [operatorName, setOperatorName] = useState(state.prefill.operatorName);
  const [agentLabel, setAgentLabel] = useState(state.prefill.agentLabel);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Advanced overrides: initialized from prefill if present, otherwise derived
  const existingDerived = deriveNames(initialSlug);
  const [agentName, setAgentName] = useState(
    state.prefill.agentName || existingDerived.agentName
  );
  const [agentEnvironmentName, setAgentEnvironmentName] = useState(
    state.prefill.agentEnvironmentName || existingDerived.agentEnvironmentName
  );
  const [agentModel, setAgentModel] = useState(
    state.prefill.agentModel || "claude-sonnet-4-6"
  );
  const [masterStoreName, setMasterStoreName] = useState(
    state.prefill.masterStoreName || existingDerived.masterStoreName
  );
  const [leadsStoreName, setLeadsStoreName] = useState(
    state.prefill.leadsStoreName || existingDerived.leadsStoreName
  );

  // When agentLabel changes (and advanced fields haven't been manually edited),
  // auto-derive the technical names so the user never needs to see them.
  const [advancedTouched, setAdvancedTouched] = useState(
    Boolean(state.prefill.agentName) // if prefill was present, treat as touched
  );

  function handleAgentLabelChange(val: string) {
    setAgentLabel(val);
    if (!advancedTouched) {
      const slug = toSlug(val || operatorName);
      const derived = deriveNames(slug);
      setAgentName(derived.agentName);
      setAgentEnvironmentName(derived.agentEnvironmentName);
      setMasterStoreName(derived.masterStoreName);
      setLeadsStoreName(derived.leadsStoreName);
    }
  }

  function handleOperatorNameChange(val: string) {
    setOperatorName(val);
    if (!advancedTouched && !agentLabel) {
      const slug = toSlug(val);
      const derived = deriveNames(slug);
      setAgentName(derived.agentName);
      setAgentEnvironmentName(derived.agentEnvironmentName);
      setMasterStoreName(derived.masterStoreName);
      setLeadsStoreName(derived.leadsStoreName);
    }
  }


  // ── Form: Kommo ──
  const [subdomain, setSubdomain] = useState(state.prefill.subdomain);
  const [accessToken, setAccessToken] = useState("");
  const [responseFieldId, setResponseFieldId] = useState("");
  const [salesbotId, setSalesbotId] = useState("");

  // ─── Shared helpers ──────────────────────────────────────────────────────
  const setStatus = (key: string, s: StepStatus) =>
    setStatuses((prev) => ({ ...prev, [key]: s }));
  const setError = (key: string, e: string | null) =>
    setErrors((prev) => ({ ...prev, [key]: e }));

  async function callStep(
    key: string,
    url: string,
    body: unknown | null,
    onOk?: (data: Record<string, unknown>) => void
  ): Promise<boolean> {
    setStatus(key, "running");
    setError(key, null);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: body ? { "content-type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || data.ok === false) {
        const msg = (data.error as string) || `HTTP ${res.status}`;
        setStatus(key, "error");
        setError(key, msg);
        return false;
      }
      setStatus(key, "done");
      onOk?.(data);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(key, "error");
      setError(key, msg);
      return false;
    }
  }

  // ─── Step handlers ────────────────────────────────────────────────────────

  // Step 1 — Anthropic key only
  async function submitAnthropicKey(e: React.FormEvent) {
    e.preventDefault();
    const ok = await callStep("anthropic", "/api/setup/credentials", {
      anthropicApiKey,
      // Don't send identity fields here; blank → conditional spread keeps existing
    });
    if (ok) setStep(2);
  }

  // Step 2 — Identity + provision agent (two sequential calls)
  async function submitAgente(e: React.FormEvent) {
    e.preventDefault();

    // 1. Save identity fields (+ optional system prompt)
    const identitySaved = await callStep("agente", "/api/setup/credentials", {
      operatorName,
      agentName,
      agentLabel,
      agentEnvironmentName,
      agentModel,
      masterStoreName,
      leadsStoreName,
      ...(systemPrompt ? { systemPrompt } : {}),
    });
    if (!identitySaved) return;

    // 2. Provision the Anthropic Environment + Managed Agent
    const agentProvisioned = await callStep("agente", "/api/setup/agent", null, (data) => {
      const env = data.environment as { id?: string } | undefined;
      const agent = data.agent as { id?: string; version?: number } | undefined;
      setProvisioned((p) => ({
        ...p,
        environmentId: env?.id ?? p.environmentId,
        agentId: agent?.id ?? p.agentId,
        agentVersion: agent?.version != null ? String(agent.version) : p.agentVersion,
      }));
    });
    if (agentProvisioned) setStep(3);
  }

  // Step 4 — Memory stores
  async function runMemoria() {
    const ok = await callStep("memoria", "/api/setup/memory", null, (data) => {
      const master = data.master as { id?: string } | undefined;
      const leads = data.leads as { id?: string } | undefined;
      setProvisioned((p) => ({
        ...p,
        masterId: master?.id ?? p.masterId,
        leadsId: leads?.id ?? p.leadsId,
      }));
    });
    if (ok) setStep(5);
  }

  // Step 5 — Kommo. One account field → derive the subdomain; the route builds
  // the api domain (<subdomain>.kommo.com) and defaults the integration id.
  async function submitKommo(e: React.FormEvent) {
    e.preventDefault();
    const ok = await callStep("kommo", "/api/setup/kommo", {
      subdomain: parseKommoSubdomain(subdomain),
      accessToken,
      ...(responseFieldId.trim() ? { responseCustomFieldId: responseFieldId.trim() } : {}),
      ...(salesbotId.trim() ? { salesbotId: salesbotId.trim() } : {}),
    });
    if (ok) setStep(6);
  }

  const currentKey: StepKey = STEPS[step].key;

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="min-h-dvh bg-neutral-50 px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-2xl space-y-6">

        {/* Header */}
        <header>
          <h1 className="text-2xl font-semibold tracking-tight text-neutral-900">
            Configuración del agente
          </h1>
          <p className="mt-1 text-sm text-neutral-600">
            Seguí los pasos para activar tu agente. Podés retomar desde donde lo
            dejaste en cualquier momento.{" "}
            <a className="font-medium underline" href="/inbox">
              Ir al dashboard
            </a>
            .
          </p>
        </header>

        {/* Step rail */}
        <ol className="flex flex-wrap gap-2">
          {STEPS.map((s, i) => {
            const isActive = i === step;
            const isDoneStep = s.key === "done";
            const statusVal: StepStatus | "completed" = isDoneStep
              ? step === 6
                ? "done"
                : "idle"
              : s.key === "supabase"
              ? "completed"
              : (statuses[s.key] as StepStatus);

            return (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => setStep(i)}
                  className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-xs transition-colors ${
                    isActive
                      ? "border-brand bg-brand text-brand-foreground"
                      : "border-neutral-200 bg-white text-neutral-600 hover:bg-neutral-100"
                  }`}
                >
                  <span className="font-medium">
                    {i + 1}. {s.label}
                  </span>
                  {!isDoneStep && <StatusBadge status={statusVal} />}
                </button>
              </li>
            );
          })}
        </ol>

        {/* Panels */}
        <div className="rounded-2xl border border-neutral-200 bg-white p-6 shadow-card">

          {/* ── Step 0: Supabase (already done) ── */}
          {currentKey === "supabase" && (
            <div className="space-y-5">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
                  1. Base de datos
                </h2>
                <p className="mt-1 text-xs text-neutral-400">
                  La base de datos ya está lista — este paso se completó durante la configuración inicial.
                </p>
              </div>
              <div className="flex items-center gap-3 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                <svg
                  className="h-4 w-4 flex-shrink-0 text-emerald-600"
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M3 8l3.5 3.5L13 4.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <span>
                  Supabase conectado y base de datos inicializada correctamente.
                </span>
              </div>
              <div className="flex gap-2">
                <Button type="button" onClick={() => setStep(1)}>
                  Continuar
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 1: Anthropic API key ── */}
          {currentKey === "anthropic" && (
            <form onSubmit={submitAnthropicKey} className="space-y-5">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
                  2. Conectá Anthropic
                </h2>
                <p className="mt-1 text-xs text-neutral-400">
                  Necesitamos tu API key de Anthropic para que el agente pueda funcionar.
                </p>
              </div>

              <Steps
                items={[
                  "Abrí console.anthropic.com e iniciá sesión con el correo que usás para la API de Claude.",
                  "Creá un espacio de trabajo (workspace) NUEVO con el nombre de tu cliente o empresa — así la facturación y los datos quedan separados.",
                  "Dentro de ese workspace, andá a Settings → API keys → Create key, copiala y pegala acá abajo.",
                ]}
              />

              <div className="space-y-2">
                <label className={labelCls}>API key de Anthropic</label>
                <input
                  type="password"
                  value={anthropicApiKey}
                  onChange={(e) => setAnthropicApiKey(e.target.value)}
                  placeholder={
                    anthropicDone
                      ? "•••••• (ya configurada — dejá vacío para conservar)"
                      : "sk-ant-..."
                  }
                  className={inputCls + " font-mono"}
                />
                <p className={hintCls}>
                  {anthropicDone
                    ? "Ya hay una key guardada. Dejá el campo vacío para conservarla, o escribí una nueva para reemplazarla."
                    : "La clave empieza con sk-ant-. Se guarda de forma segura en tu base de datos."}
                </p>
              </div>

              {errors.anthropic && <ErrorBox message={errors.anthropic} />}

              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={() => setStep(0)}>
                  Atrás
                </Button>
                <Button
                  type="submit"
                  busy={statuses.anthropic === "running"}
                >
                  {statuses.anthropic === "running"
                    ? "Validando…"
                    : "Guardar y continuar"}
                </Button>
              </div>
            </form>
          )}

          {/* ── Step 2: Agente (identity + system prompt + provision) ── */}
          {currentKey === "agente" && (
            <form onSubmit={submitAgente} className="space-y-5">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
                  3. Creá tu agente
                </h2>
                <p className="mt-1 text-xs text-neutral-400">
                  Acá le das nombre y personalidad a tu agente — cómo se va a
                  llamar, qué voz va a usar, y de qué manera se va a presentar
                  ante tus leads.
                </p>
              </div>

              {/* ✨ AI assistant — reusable component */}
              <AgentPromptAssistant
                value={systemPrompt}
                onChange={setSystemPrompt}
                onIdentity={(op, lb) => {
                  if (op && !operatorName.trim()) handleOperatorNameChange(op);
                  if (lb && !agentLabel.trim()) handleAgentLabelChange(lb);
                }}
              />

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <label className={labelCls}>Operador (tu marca o nombre)</label>
                  <input
                    value={operatorName}
                    onChange={(e) => handleOperatorNameChange(e.target.value)}
                    placeholder="Ej: SUPERCINES"
                    className={inputCls}
                  />
                  <p className={hintCls}>
                    El nombre con el que el agente se presenta: tu empresa o el
                    vendedor real. Habla en su nombre. (El asistente de arriba
                    puede completarlo por vos.)
                  </p>
                </div>
                <div className="space-y-2">
                  <label className={labelCls}>Nombre para el panel</label>
                  <input
                    value={agentLabel}
                    onChange={(e) => handleAgentLabelChange(e.target.value)}
                    placeholder="Ej: Agente SUPERCINES"
                    className={inputCls}
                  />
                  <p className={hintCls}>
                    Solo para identificar a este agente dentro del dashboard. No
                    lo ve el lead. (El asistente puede completarlo.)
                  </p>
                </div>
              </div>

              <div className="space-y-2">
                <label className={labelCls}>Personalidad / voz del agente</label>
                <textarea
                  value={systemPrompt}
                  onChange={(e) => setSystemPrompt(e.target.value)}
                  rows={8}
                  placeholder={
                    state.hasSystemPrompt
                      ? "Ya hay una personalidad guardada — dejá vacío para conservarla, o escribí una nueva para reemplazarla."
                      : "Describí cómo habla el agente, qué puede y no puede decir, cómo saluda, cómo cierra ventas…\n\nPodés completar esto ahora o más tarde desde el panel /agent."
                  }
                  className={inputCls + " leading-relaxed"}
                />
                <p className={hintCls}>
                  Podés editarlo en detalle desde{" "}
                  <a className="underline" href="/agent">
                    /agent
                  </a>{" "}
                  en cualquier momento.
                </p>
              </div>

              {/* Opciones avanzadas (collapsed by default) */}
              <div className="rounded-lg border border-neutral-200">
                <button
                  type="button"
                  onClick={() => {
                    setShowAdvanced((v) => !v);
                    if (!showAdvanced) setAdvancedTouched(true);
                  }}
                  className="flex w-full items-center justify-between px-4 py-3 text-xs font-medium text-neutral-600 hover:bg-neutral-50 rounded-lg"
                >
                  <span>Opciones avanzadas</span>
                  <svg
                    className={`h-4 w-4 transition-transform ${showAdvanced ? "rotate-180" : ""}`}
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden
                  >
                    <path
                      d="M4 6l4 4 4-4"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </button>
                {showAdvanced && (
                  <div className="border-t border-neutral-200 px-4 pb-4 pt-3 space-y-4">
                    <p className="text-xs text-neutral-500">
                      Estos nombres se generan automáticamente. Solo cambialos si
                      sabés lo que hacés.
                    </p>
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                      <div className="space-y-1">
                        <label className={labelCls + " text-xs"}>Nombre del agente</label>
                        <input
                          value={agentName}
                          onChange={(e) => setAgentName(e.target.value)}
                          className={inputCls + " font-mono text-xs"}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className={labelCls + " text-xs"}>Environment</label>
                        <input
                          value={agentEnvironmentName}
                          onChange={(e) => setAgentEnvironmentName(e.target.value)}
                          className={inputCls + " font-mono text-xs"}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className={labelCls + " text-xs"}>Memory Store master</label>
                        <input
                          value={masterStoreName}
                          onChange={(e) => setMasterStoreName(e.target.value)}
                          className={inputCls + " font-mono text-xs"}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className={labelCls + " text-xs"}>Memory Store leads</label>
                        <input
                          value={leadsStoreName}
                          onChange={(e) => setLeadsStoreName(e.target.value)}
                          className={inputCls + " font-mono text-xs"}
                        />
                      </div>
                      <div className="space-y-1">
                        <label className={labelCls + " text-xs"}>Modelo</label>
                        <select
                          value={agentModel}
                          onChange={(e) => setAgentModel(e.target.value)}
                          className={inputCls + " text-xs"}
                        >
                          <option value="claude-sonnet-4-6">
                            Sonnet 4.6 — Recomendado (equilibrio calidad/costo)
                          </option>
                          <option value="claude-opus-4-8">
                            Opus 4.8 — Máxima capacidad (más caro)
                          </option>
                          <option value="claude-haiku-4-5">
                            Haiku 4.5 — Rápido y económico
                          </option>
                        </select>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {errors.agente && <ErrorBox message={errors.agente} />}

              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={() => setStep(1)}>
                  Atrás
                </Button>
                <Button
                  type="submit"
                  busy={statuses.agente === "running"}
                >
                  {statuses.agente === "running"
                    ? "Creando agente…"
                    : statuses.agente === "done"
                    ? "Volver a crear"
                    : "Crear agente"}
                </Button>
                {statuses.agente === "done" && (
                  <Button type="button" variant="secondary" onClick={() => setStep(3)}>
                    Continuar
                  </Button>
                )}
              </div>
            </form>
          )}

          {/* ── Step 3: Verticales (IA sugiere desde el agente recién creado) ── */}
          {currentKey === "verticales" && (
            <div className="space-y-5">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
                  4. Verticales
                </h2>
                <p className="mt-1 text-xs text-neutral-400">
                  Las verticales son los tipos de mensaje que tu agente reconoce.
                  Cada una define si el agente responde sola o manda el mensaje a
                  revisión humana. Ya dejamos 3 genéricas listas; la IA te propone
                  las propias de tu negocio a partir del agente que creaste.
                </p>
              </div>

              {/* ✨ AI assistant — reusable component (reads the saved system prompt) */}
              <VerticalsAssistant onSaved={() => setStatus("verticales", "done")} />

              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={() => setStep(2)}>
                  Atrás
                </Button>
                <Button type="button" onClick={() => setStep(4)}>
                  {statuses.verticales === "done" ? "Continuar" : "Continuar sin agregar"}
                </Button>
              </div>
            </div>
          )}

          {/* ── Step 4: Memoria ── */}
          {currentKey === "memoria" && (
            <div className="space-y-5">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
                  5. Memoria y aprendizaje
                </h2>
                <p className="mt-1 text-xs text-neutral-400">
                  Con este paso, el agente recuerda cada conversación con cada
                  lead y activa el aprendizaje automático nocturno (Dreams), que
                  mejora sus respuestas solo con el tiempo.
                </p>
              </div>

              <div className="rounded-lg border border-neutral-100 bg-neutral-50 px-4 py-4 space-y-3">
                <div className="flex items-start gap-3 text-xs text-neutral-700">
                  <span className="mt-0.5 text-base leading-none">🧠</span>
                  <div>
                    <p className="font-medium">Memoria por lead</p>
                    <p className="text-neutral-500 mt-0.5">
                      El agente recuerda el historial de cada contacto para dar
                      respuestas contextualizadas.
                    </p>
                  </div>
                </div>
                <div className="flex items-start gap-3 text-xs text-neutral-700">
                  <span className="mt-0.5 text-base leading-none">✨</span>
                  <div>
                    <p className="font-medium">Aprendizaje nocturno (Dreams)</p>
                    <p className="text-neutral-500 mt-0.5">
                      Cada noche analiza las conversaciones del día y destila
                      aprendizajes que el agente aplica desde el día siguiente.
                    </p>
                  </div>
                </div>
              </div>

              {(provisioned.masterId || provisioned.leadsId) && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-xs">
                  {provisioned.masterId && (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                      <p className="uppercase tracking-wide text-emerald-600 font-medium">
                        Memoria global
                      </p>
                      <p className="mt-1 font-mono break-all text-neutral-700 text-[11px]">
                        {provisioned.masterId}
                      </p>
                    </div>
                  )}
                  {provisioned.leadsId && (
                    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3">
                      <p className="uppercase tracking-wide text-emerald-600 font-medium">
                        Memoria por lead
                      </p>
                      <p className="mt-1 font-mono break-all text-neutral-700 text-[11px]">
                        {provisioned.leadsId}
                      </p>
                    </div>
                  )}
                </div>
              )}

              {errors.memoria && <ErrorBox message={errors.memoria} />}

              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={() => setStep(3)}>
                  Atrás
                </Button>
                <Button
                  type="button"
                  onClick={runMemoria}
                  busy={statuses.memoria === "running"}
                >
                  {statuses.memoria === "running"
                    ? "Activando…"
                    : statuses.memoria === "done"
                    ? "Re-activar"
                    : "Activar memoria"}
                </Button>
                {statuses.memoria === "done" && (
                  <Button type="button" variant="secondary" onClick={() => setStep(5)}>
                    Continuar
                  </Button>
                )}
              </div>
            </div>
          )}

          {/* ── Step 5: Kommo ── */}
          {currentKey === "kommo" && (
            <form onSubmit={submitKommo} className="space-y-5">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-neutral-900">
                  6. Conectá Kommo
                </h2>
                <p className="mt-1 text-xs text-neutral-400">
                  Conectamos tu cuenta de Kommo para que el agente pueda recibir
                  y responder mensajes desde el CRM.
                </p>
              </div>

              <Steps
                items={[
                  "En Kommo, andá a Configuración → Integraciones → Crear integración privada.",
                  "En la integración creada, copiá el Token de larga duración (long-lived token). Empieza por eyJ…",
                  "Completá los campos de abajo con el token y tu subdominio de Kommo.",
                ]}
              />

              <div className="space-y-2">
                <label className={labelCls}>Tu cuenta de Kommo</label>
                <input
                  value={subdomain}
                  onChange={(e) => setSubdomain(e.target.value)}
                  placeholder="miempresa"
                  className={inputCls + " font-mono"}
                />
                <p className={hintCls}>
                  El subdominio de tu Kommo, o pegá la URL completa
                  (ej: <code>miempresa</code> o <code>https://miempresa.kommo.com</code>).
                </p>
              </div>

              <div className="space-y-2">
                <label className={labelCls}>Token de larga duración</label>
                <textarea
                  value={accessToken}
                  onChange={(e) => setAccessToken(e.target.value)}
                  rows={3}
                  placeholder={
                    kommoDone
                      ? "•••••• (ya configurado — pegá uno nuevo para reemplazar)"
                      : "eyJ0eXAiOiJKV1Qi..."
                  }
                  className={inputCls + " font-mono break-all"}
                />
              </div>

              {/* Webhook — cómo ENTRAN los mensajes de Kommo */}
              <KommoWebhookPanel />

              {/* Respuesta — cómo SALE la respuesta del agente (opcional acá) */}
              <div className="space-y-4 rounded-xl border border-neutral-200 bg-neutral-50 p-5">
                <div>
                  <h3 className="text-sm font-semibold tracking-tight text-neutral-900">
                    Cómo responde el agente
                  </h3>
                  <p className="mt-1 text-xs text-neutral-500">
                    El agente escribe su respuesta en un campo de Kommo y un
                    salesbot la envía al lead. Podés completarlo ahora o más
                    tarde en{" "}
                    <a className="underline" href="/settings">Configuración</a>.
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <label className={labelCls}>
                      Custom Field ID{" "}
                      <span className="font-normal text-neutral-400">(opcional)</span>
                    </label>
                    <input
                      value={responseFieldId}
                      onChange={(e) => setResponseFieldId(e.target.value)}
                      inputMode="numeric"
                      placeholder="123456"
                      className={inputCls + " font-mono"}
                    />
                    <p className={hintCls}>
                      En Kommo → Configuración → Campos del lead, creá un campo de
                      texto largo y pegá su ID numérico. El agente escribe ahí.
                    </p>
                  </div>
                  <div className="space-y-2">
                    <label className={labelCls}>
                      Salesbot ID{" "}
                      <span className="font-normal text-neutral-400">(opcional)</span>
                    </label>
                    <input
                      value={salesbotId}
                      onChange={(e) => setSalesbotId(e.target.value)}
                      inputMode="numeric"
                      placeholder="78910"
                      className={inputCls + " font-mono"}
                    />
                    <p className={hintCls}>
                      En Kommo → Automatización → Salesbots, creá un bot que lea
                      ese campo y lo envíe al canal del lead. Pegá su ID.
                    </p>
                  </div>
                </div>
              </div>

              {errors.kommo && <ErrorBox message={errors.kommo} />}

              <div className="flex gap-2">
                <Button type="button" variant="secondary" onClick={() => setStep(4)}>
                  Atrás
                </Button>
                <Button
                  type="submit"
                  busy={statuses.kommo === "running"}
                >
                  {statuses.kommo === "running" ? "Verificando…" : "Verificar y guardar"}
                </Button>
              </div>
            </form>
          )}

          {/* ── Step 6: Done ── */}
          {currentKey === "done" && (
            <div className="space-y-5">
              <div>
                <h2 className="text-xl font-semibold tracking-tight text-neutral-900">
                  ¡Tu agente está listo!
                </h2>
                <p className="mt-1 text-sm text-neutral-500">
                  Todo está configurado. A partir de ahora, el agente puede
                  recibir mensajes de Kommo y responder automáticamente.
                </p>
              </div>

              <dl className="space-y-2 text-xs">
                {[
                  ["Agente", provisioned.agentId ? `${provisioned.agentId}${provisioned.agentVersion ? ` (v${provisioned.agentVersion})` : ""}` : null],
                  ["Memoria global", provisioned.masterId],
                  ["Memoria por lead", provisioned.leadsId],
                  ["Kommo", state.kommoDone || statuses.kommo === "done" ? "conectado" : null],
                ].map(([k, v]) => (
                  <div
                    key={k}
                    className="flex items-center justify-between rounded-lg border border-neutral-200 bg-neutral-50 px-3 py-2"
                  >
                    <span className="uppercase tracking-wide text-neutral-500">{k}</span>
                    <span className="font-mono break-all text-neutral-900">{v ?? "—"}</span>
                  </div>
                ))}
              </dl>

              <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800">
                <p className="font-medium mb-1">Próximo paso recomendado</p>
                <p>
                  Andá a{" "}
                  <a className="font-medium underline" href="/settings">
                    Configuración
                  </a>{" "}
                  y activá el modo de validación (
                  <span className="font-medium">Agente ON + Publicar OFF</span>
                  ) para revisar las respuestas antes de que lleguen a tus leads.
                </p>
              </div>

              <a
                href="/inbox"
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-brand-foreground transition-colors hover:bg-brand/90"
              >
                Ir al dashboard
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

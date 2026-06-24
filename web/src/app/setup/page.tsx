import { getRuntimeConfig } from "@/lib/runtime-config";
import { SetupWizard } from "./wizard";
import { InitBanner } from "./init-banner";

export const dynamic = "force-dynamic";

// /setup lives OUTSIDE the (dashboard) group but is still behind the auth
// middleware (only the master user can reach it). It reads runtime_config to
// compute which steps are already done so the wizard is resumable.
//
// IMPORTANT: step completion is computed from the DB ONLY (getRuntimeConfig),
// NOT with the env-var fallback. A value that exists only in the host env
// (e.g. a leftover ANTHROPIC_API_KEY pasted into Netlify) must NOT make a step
// show as "Listo" — the wizard's whole job is to populate runtime_config, so
// "done" must mean "the wizard wrote it to the DB".
export default async function SetupPage() {
  const db = await getRuntimeConfig(); // DB-only map (null/empty already stripped)
  const v = (k: string) => db[k] ?? "";

  return (
    <>
      <InitBanner />
      <SetupWizard
        state={{
          credentialsDone: Boolean(v("ANTHROPIC_API_KEY")),
          memoryDone: Boolean(v("ANTHROPIC_MEMORY_MASTER_ID") && v("ANTHROPIC_MEMORY_LEADS_ID")),
          agentDone: Boolean(v("ANTHROPIC_AGENT_ID")),
          kommoDone: Boolean(v("KOMMO_ACCESS_TOKEN")),
          hasSystemPrompt: Boolean(v("SYSTEM_PROMPT")),
          prefill: {
            operatorName: v("OPERATOR_NAME"),
            agentName: v("AGENT_NAME"),
            agentLabel: v("NEXT_PUBLIC_AGENT_LABEL"),
            agentEnvironmentName: v("AGENT_ENVIRONMENT_NAME"),
            agentModel: v("AGENT_MODEL"),
            masterStoreName: v("MEMORY_STORE_MASTER_NAME"),
            leadsStoreName: v("MEMORY_STORE_LEADS_NAME"),
            subdomain: v("KOMMO_SUBDOMAIN"),
            apiDomain: v("KOMMO_API_DOMAIN"),
          },
          provisioned: {
            masterId: v("ANTHROPIC_MEMORY_MASTER_ID") || null,
            leadsId: v("ANTHROPIC_MEMORY_LEADS_ID") || null,
            environmentId: v("ANTHROPIC_ENVIRONMENT_ID") || null,
            agentId: v("ANTHROPIC_AGENT_ID") || null,
            agentVersion: v("ANTHROPIC_AGENT_VERSION") || null,
          },
        }}
      />
    </>
  );
}

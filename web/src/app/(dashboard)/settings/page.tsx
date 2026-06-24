import { createSupabaseServerClient } from "@/lib/supabase/server";
import { configValue } from "@/lib/runtime-config";
import { getShopifyStatus } from "@/lib/shopify";
import { Badge, Button, PageShell, SectionCard, StatCard, inputCls, selectCls } from "@/components/ui";
import { KommoFieldSelect } from "./kommo-field-select";
import { KommoWebhookPanel } from "@/components/kommo-webhook-panel";
import { UpdatesPanel } from "./updates-panel";
import { ShopifyConnect } from "./shopify-connect";
import { SettingsTabs, type SettingsTab } from "./settings-tabs";

export const dynamic = "force-dynamic";

export default async function SettingsPage({
  searchParams,
}: {
  searchParams: { saved?: string; alerts_saved?: string; tab?: string };
}) {
  const supabase = createSupabaseServerClient();
  const { data: config } = await supabase
    .from("kommo_publish_config")
    .select("response_custom_field_id, salesbot_id, publishing_enabled, auto_reply_mode, agent_enabled, bypass_review, publish_from")
    .eq("is_active", true)
    .single();
  const { data: alertCfg } = await supabase
    .from("alert_config")
    .select("webhook_url, webhook_enabled")
    .eq("is_active", true)
    .single();

  const shopifyStatus = await getShopifyStatus();
  const autoUpdateEnabled = (await configValue("AUTO_UPDATE_ENABLED")) !== "0";

  const saved = searchParams.saved === "1";
  const alertsSaved = searchParams.alerts_saved === "1";

  // Pestaña inicial: tras guardar caemos en la pestaña del form para mostrar la
  // confirmación al lado (Publicación → Publicación Kommo; Alertas → Sistema);
  // si no, respetamos ?tab.
  const initialTab: SettingsTab =
    alertsSaved || searchParams.tab === "sistema"
      ? "sistema"
      : saved || searchParams.tab === "publicacion"
        ? "publicacion"
        : "conexiones";

  // ── Slot: Conexiones ──────────────────────────────────────────────────────
  const conexiones = (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <KommoWebhookPanel />
      <ShopifyConnect connected={shopifyStatus.configured} domain={shopifyStatus.domain} />
    </div>
  );

  // ── Slot: Publicación ─────────────────────────────────────────────────────
  const publicacion = (
    <div className="space-y-4">
      <SectionCard
        title="Estado actual"
        description="Resumen de la configuración de publicación activa."
      >
        {config?.agent_enabled && !config?.publishing_enabled && (
          <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-xs text-blue-800">
            <span className="font-semibold">Modo validación activo.</span> El agente
            responde y los drafts quedan en plataforma para revisar, pero NO se
            envían a Kommo.
          </div>
        )}
        {!config?.agent_enabled && (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-xs text-red-700">
            <span className="font-semibold">Agente deshabilitado.</span> No genera
            ninguna respuesta (kill switch).
          </div>
        )}
        {config?.publish_from && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs text-emerald-800">
            <span className="font-semibold">Publicando desde:</span>{" "}
            {new Date(config.publish_from).toLocaleString("es", {
              dateStyle: "medium",
              timeStyle: "short",
            })}
            . Los borradores anteriores (validación) no se envían — quedan solo como
            registro.
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <StatCard
            label="Agente"
            value={
              <Badge color={config?.agent_enabled ? "green" : "red"} size="md">
                {config?.agent_enabled ? "Activo" : "Deshabilitado"}
              </Badge>
            }
            tone={config?.agent_enabled ? "emerald" : "red"}
          />
          <StatCard
            label="Publicación"
            value={
              <Badge color={config?.publishing_enabled ? "green" : "amber"} size="md">
                {config?.publishing_enabled ? "Activo" : "Modo validación"}
              </Badge>
            }
            tone={config?.publishing_enabled ? "emerald" : "amber"}
          />
          <StatCard
            label="Bypass review"
            value={
              <Badge color={config?.bypass_review && config?.publishing_enabled ? "amber" : "neutral"} size="md">
                {config?.bypass_review && config?.publishing_enabled ? "ON" : "OFF"}
              </Badge>
            }
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
            <p className="text-xs text-neutral-500 uppercase tracking-wide">Field ID</p>
            <p className="mt-1 font-mono text-sm text-neutral-900">
              {config?.response_custom_field_id ?? "(no configurado)"}
            </p>
          </div>
          <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
            <p className="text-xs text-neutral-500 uppercase tracking-wide">Salesbot ID</p>
            <p className="mt-1 font-mono text-sm text-neutral-900">
              {config?.salesbot_id ?? "(no configurado)"}
            </p>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title="Publicación Kommo"
        description="Campo destino, salesbot y modo de respuesta automática."
      >
        <form action="/api/settings/kommo" method="post" className="space-y-5">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-700">
              Campo donde escribe el agente
            </label>
            <KommoFieldSelect
              name="response_custom_field_id"
              defaultValue={config?.response_custom_field_id ?? null}
            />
            <p className="text-xs text-neutral-500">
              Elegí el campo del lead (de tu cuenta Kommo) donde el agente deja cada respuesta. Si no aparece, creálo en Kommo como campo de texto largo y recargá.
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-700">Salesbot ID</label>
            <input
              type="number"
              name="salesbot_id"
              defaultValue={config?.salesbot_id ?? ""}
              placeholder="78910"
              className={inputCls + " font-mono"}
            />
            <p className="text-xs text-neutral-500">
              Kommo no permite listar los bots por API, por eso va el número a mano: abrí tu bot en Kommo → Salesbot y copiá el número que aparece en la URL (…/salesbot/<span className="font-mono">12345</span>).
            </p>
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-700">
              Modo para verticales con auto_reply
            </label>
            <select
              name="auto_reply_mode"
              defaultValue={config?.auto_reply_mode ?? "auto"}
              className={selectCls}
            >
              <option value="auto">auto — publica directo al canal</option>
              <option value="review_only">review_only — todo va a revisión humana (override)</option>
            </select>
          </div>

          <div className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                name="agent_enabled"
                defaultChecked={config?.agent_enabled ?? true}
                className="h-5 w-5 rounded border-neutral-300 text-brand focus:ring-brand"
              />
              <span className="font-medium text-neutral-900">Agente habilitado</span>
            </label>
            <p className="text-xs text-neutral-500">
              Si está activo, el agente responde y genera drafts. Si está desactivado, NO genera ninguna respuesta (kill switch).
            </p>
          </div>

          <div className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                name="publishing_enabled"
                defaultChecked={config?.publishing_enabled ?? false}
                className="h-5 w-5 rounded border-neutral-300 text-brand focus:ring-brand"
              />
              <span className="font-medium text-neutral-900">Publishing habilitado</span>
            </label>
            <p className="text-xs text-neutral-500">
              Si está desactivado, el sistema genera drafts pero NO los publica a Kommo (shadow mode seguro).
              Activalo cuando estés listo para producción.
            </p>
          </div>

          <div
            className={
              "space-y-2 rounded-lg border p-4 " +
              (config?.publishing_enabled
                ? "border-amber-200 bg-amber-50"
                : "border-neutral-200 bg-neutral-100")
            }
          >
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                name="bypass_review"
                defaultChecked={config?.bypass_review ?? false}
                disabled={!config?.publishing_enabled}
                className="h-5 w-5 rounded border-neutral-300 text-brand focus:ring-brand disabled:opacity-40"
              />
              <span className="font-medium text-neutral-900">Ignorar review (bypass)</span>
            </label>
            <p className="text-xs text-neutral-500">
              Si está activo, el agente responde y publica SIEMPRE, aunque el mensaje entrara a revisión humana.
              Solo se puede activar con <span className="font-medium">Publishing habilitado</span>
              {!config?.publishing_enabled && " (activá y guardá Publishing primero)"}.
            </p>
          </div>

          <p className="text-xs text-neutral-400">
            ¿Buscás los límites de respuesta por lead o apagar el agente para un lead?{" "}
            <a href="/agent?tab=filtros" className="font-medium text-brand underline">
              Agente → Filtros
            </a>
            .
          </p>

          <Button type="submit" variant="primary">Guardar</Button>
        </form>
      </SectionCard>
    </div>
  );

  // ── Slot: Sistema ─────────────────────────────────────────────────────────
  const sistema = (
    <div className="space-y-4">
      {alertsSaved && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          ✓ Configuración de alertas guardada
        </div>
      )}

      <UpdatesPanel autoUpdateEnabled={autoUpdateEnabled} />

      <SectionCard
        title="Alertas"
        description="Webhook opcional para recibir alertas en Slack/Discord/Zapier."
      >
        <form action="/api/settings/alerts" method="post" className="space-y-4">
          <div className="space-y-2">
            <label className="block text-sm font-medium text-neutral-700">Webhook URL</label>
            <input
              type="url"
              name="webhook_url"
              defaultValue={alertCfg?.webhook_url ?? ""}
              placeholder="https://hooks.slack.com/services/... o https://discord.com/api/webhooks/..."
              className={inputCls + " font-mono"}
            />
            <p className="text-xs text-neutral-500">
              Compatible con Slack (campo &quot;text&quot;) y Discord (campo &quot;embeds&quot;). Para email, usá un Zap entrante.
            </p>
          </div>
          <div className="space-y-2 rounded-lg border border-neutral-200 bg-neutral-50 p-4">
            <label className="flex items-center gap-3 text-sm">
              <input
                type="checkbox"
                name="webhook_enabled"
                defaultChecked={alertCfg?.webhook_enabled ?? false}
                className="h-5 w-5 rounded border-neutral-300 text-brand focus:ring-brand"
              />
              <span className="font-medium text-neutral-900">Webhook habilitado</span>
            </label>
          </div>
          <Button type="submit" variant="primary">Guardar</Button>
        </form>
      </SectionCard>
    </div>
  );

  return (
    <PageShell title="Configuración" width="narrow">
      {saved && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          ✓ Configuración guardada
        </div>
      )}

      <SettingsTabs
        initialTab={initialTab}
        conexiones={conexiones}
        publicacion={publicacion}
        sistema={sistema}
      />
    </PageShell>
  );
}

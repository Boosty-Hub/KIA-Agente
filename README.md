# Template-Agent-kommo

Template para construir un agente conversacional sobre **Kommo CRM + Claude Sonnet (Anthropic Managed Agents) + Supabase**. Da out-of-the-box: clasificación de mensajes (Haiku), respuesta con voz custom (Sonnet + Memory Stores), debounce/batching, aprendizajes automáticos nocturnos (Dreams), evaluación de calidad (Outcomes), y panel de revisión humana.

## Regla #1 — Nunca edites este repo

Este repo es **la plantilla**. Cada agente nuevo arranca creando **un repo propio** a partir de este template. Después trabajás en ese repo nuevo, nunca acá.

```bash
# gh CLI
gh repo create <tu-org>/<nombre-agente> \
  --template Boosty-Hub/Template-Agent-kommo \
  --private --clone
cd <nombre-agente>

# o desde github.com: botón "Use this template" → "Create a new repository"
```

---

## Desplegar un cliente nuevo — flujo zero-CLI

No hay `pnpm bootstrap`. Todo sucede desde el navegador.

### Paso 1 — Crear la infraestructura externa (manual, una vez)

| Qué | Dónde |
|-----|-------|
| Proyecto Supabase | supabase.com → New project |
| API key de Anthropic | console.anthropic.com/settings/keys |
| Integración privada en Kommo | Settings → Integrations → tipo Private → scope `crm` |

### Paso 2 — Deployar el dashboard en tu host

Deployá el repo en Netlify o Vercel. El proyecto Next.js vive en `web/`.

| Host | Config mínima |
|------|---------------|
| Netlify | Base directory: `web/` (ya en `netlify.toml`) |
| Vercel | Root directory: `web/` |

**Constraint de build**: el directorio `web/` necesita acceso a `../supabase/` para correr el codegen (`predev`/`prebuild`). Asegurate de que el host clone el repo completo (no solo `web/`). Netlify y Vercel hacen checkout completo por defecto — no necesitás nada extra.

### Paso 3 — Configurar las 3 variables de entorno en el host

Antes del primer redeploy, configurá estas variables en tu host (Site Settings en Netlify, o Project Settings en Vercel):

| Variable | Dónde obtenerla |
|----------|-----------------|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API → Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Mismo lugar → Legacy API keys → `anon (public)` |
| `SUPABASE_SERVICE_ROLE_KEY` | Mismo lugar → Legacy API keys → `service_role (secret)` |

> Las claves legacy JWT (que empiezan con `eyJ...`) son las que funcionan con PostgREST. NO uses las nuevas `sb_publishable_*` para este caso.

Luego redesploya el sitio. Abrí la URL desplegada — el wizard de configuracion inicial arranca automáticamente.

### Paso 4 — Wizard de configuracion inicial (`/first-run`)

El wizard te guia por tres pasos:

1. **Conectar** — instrucciones para configurar las variables (ya las configuraste en el paso 3). El wizard detecta la conexión automáticamente y avanza.
2. **Inicializar** — pegás tu Personal Access Token de Supabase (`sbp_...`, de `supabase.com/dashboard/account/tokens`) y el wizard aplica las 17 migraciones SQL y deploya las 8 Edge Functions en tu proyecto. Todo con barra de progreso por unidad.
3. **Crear usuario** — email + contraseña para el único usuario del dashboard. El sistema bloquea registros adicionales automáticamente.

Tras crear el usuario, el wizard redirige a `/setup`.

### Paso 5 — Wizard de provisioning Anthropic + Kommo (`/setup`)

El wizard existente provisiona:

1. Credenciales de Anthropic + identidad del agente.
2. Memory Stores (master + leads).
3. Managed Agent con el system prompt.
4. Conexión Kommo (token long-lived, subdominio, dominio API).

Todo se guarda en `runtime_config` (la base de datos), no en variables de entorno. Idempotente — podés re-correrlo sin duplicar nada.

### Paso 6 — Configurar Kommo (en el panel de Kommo)

- Webhook URL: `https://<ref>.supabase.co/functions/v1/kommo-webhook`
- Eventos: Mensaje agregado, Lead agregado, Lead actualizado
- En `/settings` del dashboard: `response_custom_field_id` + `salesbot_id`

### Paso 7 — Activar el agente

En `/settings`: `agent_enabled = true`, `publishing_enabled = false` (shadow al principio). Cuando confirmes calidad: `publishing_enabled = true`.

---

## Desarrollo local

```bash
# Desde web/ — requiere web/.env.local con las 3 vars de Supabase
cd web
pnpm install
pnpm dev           # arranca en :3000; corre codegen automáticamente

# Typecheck (no hay test suite)
npx tsc --noEmit

# Re-deploy de una Edge Function puntual
SUPABASE_ACCESS_TOKEN=<token> \
  npx supabase functions deploy <fn> --project-ref <ref>
```

Para desarrollo local necesitás `web/.env.local`. Copiá desde `web/.env.example`:

```bash
cp web/.env.example web/.env.local
# Completá NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY
```

---

## Stack

- **Next.js 14** (App Router, TS, Tailwind) — dashboard + Route Handlers
- **Supabase** — Postgres 17 + pgvector + Auth + Realtime + Edge Functions (Deno 2)
- **Anthropic** — Haiku 4.5 (clasificación), Sonnet 4.6 (CMA), Memory Stores
- **Kommo CRM** — webhook entrante, REST v4, Salesbot v2

## Qué customizar por cliente

| Qué | Dónde |
|-----|-------|
| Voz / system prompt | Dashboard `/agent` → sincroniza con Anthropic al guardar |
| Identidad del agente y branding | Dashboard `/agent` o wizard `/setup` |
| Provisioning Anthropic + Kommo | Dashboard `/setup` (idempotente) |
| Verticales (categorías de mensajes) | Dashboard `/verticales` |
| Prompts de graders | Dashboard `/outcomes` |
| Switches operativos | Dashboard `/settings` |
| Variables irreducibles de Supabase | Host env vars (las 3 de arriba) |

## Estructura

```
.
├── SETUP-WITH-CLAUDE.md           # playbook para setup asistido por Claude
├── agent/
│   ├── system-prompt.example.md  # template del system prompt
│   └── from-n8n.md               # guía para importar un workflow n8n
├── supabase/
│   ├── migrations/               # 17 SQL idempotentes; cron URLs usan ${SUPABASE_URL}
│   ├── functions/                # 8 Edge Functions Deno con verify_jwt=false
│   └── config.toml
├── web/                          # Next.js 14 dashboard
│   └── scripts/
│       └── embed-provision.mjs  # codegen: embebe migrations + functions en TS
├── .env.example                  # referencia de vars (raíz — solo para dev local)
├── web/.env.example              # vars del front (las 3 obligatorias)
├── netlify.toml
├── CLAUDE.md                     # arquitectura + invariantes críticos
└── README.md
```

## Documentación

- **`CLAUDE.md`** — arquitectura del pipeline, invariantes críticos (`verify_jwt`, `waitUntil`, debounce, switches). Leer antes de tocar Edge Functions.
- **`SETUP-WITH-CLAUDE.md`** — playbook paso a paso para setup asistido por Claude Code.

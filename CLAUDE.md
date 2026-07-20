# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Qué es

Template para construir un **agente conversacional sobre Kommo CRM** con clasificación (Haiku 4.5), respuesta vía Anthropic Managed Agent (Sonnet 4.6 + Memory Stores), aprendizaje automático nocturno (Dreams) y evaluación de calidad (Outcomes). Se customiza para cualquier operador **desde el dashboard** (`/setup` + `/agent`), sin tocar código.

Repo: `web/` (Next.js 14 dashboard + API routes) + `supabase/` (Postgres migrations + Edge Functions Deno) + `agent/` (template de system prompt).

## Desplegar un cliente nuevo (zero-CLI — todo desde el navegador)

El flujo es **single-tenant**: un clon = un cliente. Cada cliente tiene su propio Supabase, su propia conexión Kommo y su propia cuenta/API key de Anthropic. La personalización por cliente vive en la tabla `runtime_config` (DB), editable desde el dashboard — NO se edita código.

1. **Crear infra externa** (manual, irreducible): un proyecto Supabase nuevo, una API key de Anthropic, una integración long-lived token en Kommo.
2. **Deployar en Netlify/Vercel** (import from Git, una vez): en **Netlify es zero-config** — `netlify.toml` ya fija `base = "web"`, `command = "pnpm build"`, `publish = ".next"`, Node 20 y `@netlify/plugin-nextjs`. En Vercel: root directory = `web/`, build `pnpm build`. El host hace checkout del repo **completo** (no solo `web/`) para que el codegen lea `../supabase/` en el build. El **primer deploy FALLA** hasta cargar las env vars — es esperado.
3. **Configurar las 3 variables en el host** (Netlify: Site configuration → Environment variables · Vercel: Project Settings → Environment Variables), luego **redesplegar**. Las tres salen del proyecto Supabase nuevo en **Project Settings → API**. ⚠️ Usar las keys **LEGACY JWT** (empiezan con `eyJ`), NO las nuevas `sb_publishable_`/`sb_secret_` (PostgREST rechaza las nuevas):
   - `NEXT_PUBLIC_SUPABASE_URL` — Project URL (`https://<ref>.supabase.co`)
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` — Legacy API keys → `anon (public)`
   - `SUPABASE_SERVICE_ROLE_KEY` — Legacy API keys → `service_role (secret)`
4. **Abrir la URL** → el wizard `/first-run` detecta el estado y guía el siguiente paso.
5. **Wizard `/first-run`**: paso Conectar (ya hecho) → paso Inicializar (pegás un Personal Access Token `sbp_...` de `supabase.com/dashboard/account/tokens`; el wizard aplica las migraciones + deploya las Edge Functions con progreso en vivo) → paso Crear usuario (email + contraseña; bloquea registros adicionales). **Acá el onboarding crea/provisiona todo el proyecto solo.**
6. **Wizard `/setup`**: Anthropic credentials + Memory Stores + Managed Agent + Kommo. Idempotente.
7. **`/agent`**: editás voz/identidad/branding cuando quieras; al guardar sincroniza el system prompt con Anthropic (sube versión).

> **Guía paso-a-paso completa** (para humanos, con cada wizard detallado): `README.md` (Pasos 1-7) y `SETUP-WITH-CLAUDE.md` (Fase 4 deploy Netlify/Vercel · Fase 5 env vars + `/first-run`). Mantené estas tres en sync si cambia el flujo.

### Codegen automático

`pnpm dev` y `pnpm build` corren automáticamente `node scripts/embed-provision.mjs` (hooks `predev`/`prebuild`). El script embebe todas las migraciones SQL y el source de las 9 Edge Functions en archivos TypeScript generados (`web/src/lib/provision/*.generated.ts`, gitignoreados). Esto permite que el wizard `/first-run` aplique migraciones y despliegue funciones sin acceso al filesystem en runtime. **Si el directorio `../supabase/` no existe, el build falla intencionalmente** — diseñado para que el build no pase en silencio con un provisioner vacío.

### Precedencia de config (clave)

`runtime_config` es la **single source of truth**. Web y Edge Functions resuelven cada key **DB-first / env-fallback**: si la fila existe y `value` no es NULL ni `""` → se usa; si no → variable de entorno; si no → undefined. Los lectores: `web/src/lib/runtime-config.ts` (React `cache()` por request) y `supabase/functions/_shared/config.ts` (cache TTL 60s, lectura en runtime). Tras escribir config desde el dashboard, las Edge Functions la toman dentro de 60s sin redeploy.

```bash
# Front (desde web/)
cd web && pnpm install
pnpm dev            # dev server :3000; corre codegen automáticamente al arrancar
pnpm build
npx tsc --noEmit    # typecheck — correr SIEMPRE tras editar el front (no hay test suite)

# Re-deploy de una Edge Function puntual
SUPABASE_ACCESS_TOKEN=<token> npx supabase functions deploy <fn> --project-ref <ref>
```

> No hay `pnpm bootstrap`, `pnpm migrate` ni `pnpm user:master`. Esos scripts fueron eliminados. Todo sucede desde el browser vía `/first-run`. Para desarrollo local, el codegen corre automáticamente en `predev`.

No hay tests ni linter más allá de `eslint-config-next`. Verificación de cada cambio del front: `npx tsc --noEmit`. Para Edge Functions no hay typecheck local (Deno); validar desplegando y golpeando la función.

## Arquitectura — el pipeline (lo más importante)

Mensaje entra a Kommo → llega al sistema y fluye así, **todo desacoplado por la tabla `inbound_queue` + Edge Functions encadenadas**:

```
Kommo webhook ──> kommo-webhook ──> inbound_queue (pending)
                                          │ (waitUntil)
                                          ▼
                   process-inbound: parsea payload, upsert leads, inserta
                   messages, clasifica inbound con Haiku 4.5 (vertical +
                   intent/urgency/toxicity/requires_human_review)
                                          │ (waitUntil, modo cola sin message_id)
                                          ▼
                   generate-response: DEBOUNCE 45s por lead → batch de
                   TODOS los mensajes sin responder del lead → sesión CMA
                   (Sonnet 4.6) con Memory Stores montados → 1 draft
                                          │ (si approved)
                                          ▼
                   publish-to-kommo: PATCH custom field configurado +
                   corre salesbot → evaluate-outcomes (graders)
```

Resiliencia: `pg_cron` barre cada minuto `process-inbound`, `generate-response`, `publish-to-kommo` (migraciones 0006/0007/0013) por si el fire-and-forget se corta. `dreams-run` (daily/weekly) y `evaluate-outcomes`/`alerts-scan` (cada 5 min) también por cron.

### Invariantes críticos (romperlos rompe producción)

1. **`verify_jwt = false` para TODAS las Edge Functions.** Kommo postea sin JWT; con `verify_jwt=true` da 401 y nada entra. En deploys por CLI, está fijado en `supabase/config.toml` bajo `[functions.*]`. En deploys desde el browser (wizard `/first-run`), se fuerza vía la metadata del API call: `{ verify_jwt: false }` en cada llamada a `POST /v1/projects/{ref}/functions/deploy` (ver `web/src/lib/provision/management.ts`). **Nunca quitar ninguno de los dos mecanismos.**

2. **El trabajo lento del agente va dentro de `EdgeRuntime.waitUntil()`.** `generate-response` crea el draft `pending`, devuelve **202 de inmediato**, y corre el agente (~60-80s) en `waitUntil`. Si se hiciera antes de responder, el runtime mata la función al desconectarse el cliente (pg_net/fire-and-forget) → draft `pending` eterno. Mismo patrón en `kommo-webhook`→`process-inbound` y `process-inbound`→`generate-response`.

3. **Debounce + batching.** `process-inbound` dispara `generate-response` en **modo cola** (sin `message_id`) para que aplique el debounce. `generate-response` espera 45s de silencio desde el último inbound del lead y responde TODOS sus mensajes pendientes en UN solo draft (resuelve los "3 mensajes cortados = una idea"). `messages.answered_by_draft_id` marca todo el batch como cubierto (FK `on delete set null` → si el draft se borra por stale, se reprocesan). Drafts `pending` con `agent_metadata.generating=true` >8min se consideran runs muertos: un barrido global al inicio del modo cola los borra (el FK libera su batch para reprocesar). El umbral es holgado adrede — runs vivos con muchos tool calls llegan a ~2.5min, y borrar un run vivo solo duplica trabajo (las guardas `status='pending'` en delete/update evitan perder o duplicar respuestas).

4. **Tres switches en `kommo_publish_config` (singleton `is_active=true`):**
   - `agent_enabled` — kill switch; si `false` `generate-response` no genera nada.
   - `publishing_enabled` — si `false`, drafts se generan pero NO se publican (shadow/validación).
   - `bypass_review` — si `true` (y `publishing_enabled=true`), el agente responde y publica TODO aunque entre a review. No afecta el botón de revisión humana (forceReview siempre queda `pending`).
   - Combinación de validación inicial: `agent_enabled=true, publishing_enabled=false`.

5. **Migraciones con `${SUPABASE_URL}` placeholder.** Las migraciones que crean cron jobs (0006, 0007, 0009, 0010, 0011, 0013) usan `'${SUPABASE_URL}/functions/v1/<fn>'` en lugar de URLs hardcoded. La sustitución ocurre **en runtime** dentro de `web/src/app/api/provision/migrate/route.ts` antes de ejecutar cada SQL. El placeholder viaja intacto en los archivos `.sql` y en el archivo generado `migrations.generated.ts`. **No reemplazar el placeholder con la URL real en los archivos SQL** — dejá el placeholder para que el repo siga siendo reusable.

### Memoria y aprendizaje (Anthropic Managed Agents)

- Dos Memory Stores montados como filesystem en la sesión CMA. Sus nombres reales se configuran vía env vars (`MEMORY_STORE_MASTER_NAME` / `MEMORY_STORE_LEADS_NAME`):
  - **master** (read-only, global a todos los leads): `/voice/` (voz), `/kb/` (KB destilada), `/dreams/` (aprendizajes).
  - **leads** (read-write, por lead): `/<lead_id>/conversation.md` + `learnings.md`.
- En el código (web + edge) usamos los labels semánticos `"master"` y `"leads"` para no acoplar el schema a un nombre específico de store. El ID real viene de `ANTHROPIC_MEMORY_MASTER_ID` / `_LEADS_ID`.
- **Dreams**: `dreams-run` analiza conversaciones (24h/7d), Sonnet destila learnings y los escribe como `.md` en `<master>/dreams/`. El system prompt del agente obliga a leer `/dreams/` con **prioridad mayor que la voz base** antes de redactar. No es reentrenamiento: es retrieval en vivo. Cada learning lleva `severity` (sugerencia|advertencia|error, codificada también en el filename como `sug|adv|err`) y la política `runtime_config.DREAMS_AUTO_ACTIVATE` decide qué se activa solo: `all` (default), `error` (solo errores se auto-activan = autocorrección; el resto espera aprobación) o `none`. Lo no activado va a `/dreams-pending/` (el agente NO lo lee) y se aprueba/descarta desde `/dreams`. Todo dream `error` genera una alerta (`kind=dream_error`). El dashboard permite borrar activos (borra el archivo del Memory Store → el agente deja de adoptarlo).
- **Schedule de Dreams** (editable en `/dreams`): `DREAMS_ENABLED` (`"false"` apaga diario + semanal) y `DREAMS_EVERY_DAYS` (el análisis diario corre cada N días). El cron sigue disparando a diario 3 AM UTC; `dreams-run` aplica el gate usando `DREAMS_LAST_DAILY` (lo escribe tras cada corrida diaria). El botón "Run" manual envía `force:true` y salta el gate.
- **Audio (notas de voz)**: si `respond_to_audio=true` y hay `OPENAI_API_KEY` en `runtime_config`, `process-inbound` transcribe con Whisper (`whisper-1`) y el texto sigue el pipeline normal (se guarda como `🎙️ <transcript>`). Sin key → `media_audio_no_key`; transcripción fallida → `requires_human_review`. La key se pide al activar el toggle en `/agent` → Filtros → Multimedia.
- `search_kb` es un custom tool del agente: embeddings gte-small 384d (`embed` function) + RPC `search_kb` (vector 0.7 + FTS español 0.3).
- Captura de mensajes salientes manuales de Kommo: **no resuelto**. El webhook `leads.add` no trae texto; los mensajes tecleados a mano viven en el sistema de chat de Kommo (amojo, credenciales aparte). Lo único recuperable vía API es lo que pasa por el custom field configurado (eventos `/api/v4/events`).

### System prompt del agente

El system prompt vivo está en `runtime_config.SYSTEM_PROMPT` (DB), editable desde el dashboard en `/agent`. Soporta placeholders que se sustituyen al sincronizar con Anthropic:
- `{{OPERATOR_NAME}}` — de `runtime_config.OPERATOR_NAME`.
- `{{MASTER_PATH}}` / `{{LEADS_PATH}}` — `/mnt/memory/<MEMORY_STORE_*_NAME>`.
- `{{MEMORY_STORE_MASTER}}` / `{{MEMORY_STORE_LEADS}}` — nombres de los stores.

La sustitución y la lista de tools viven en `web/src/lib/agent-prompt.ts` (compartidas por `/api/agent` y `/api/setup/agent`). Guardar en `/agent` llama `anthropic.beta.agents.update()` y persiste la versión nueva en `runtime_config.ANTHROPIC_AGENT_VERSION`. `agent/system-prompt.example.md` (commiteado) es el template de partida para copiar/pegar al wizard; el prompt vivo está en `runtime_config.SYSTEM_PROMPT`. `agent/system-prompt.kia-live.md` es el **snapshot commiteado del prompt vivo** de este deployment (solo referencia/historial — editarlo NO cambia el agente): tras editar el prompt en DB + sincronizar con Anthropic, actualizar ese snapshot en el mismo commit.

### Tools del agente — acciones sobre Kommo (gated)

Además de `search_kb`, el agente tiene tools internas (`tool_type='system'` en `agent_tools`) que **operan el CRM POR NOMBRE** (no por ID): resuelven etapa/campo en vivo contra la API de Kommo. Se despachan en `runCrmTool` dentro de `supabase/functions/generate-response/index.ts`; los helpers HTTP viven en `_shared/kommo.ts`. Cada capacidad tiene un **gate** en `kommo_publish_config` (default OFF), editable en `/agent → Acciones` (`agent/crm-actions-panel.tsx` → `/api/agent/crm-actions`). **Declaración gate-aware**: una tool `system` con gate OFF **NO se declara** al Managed Agent (`filterToolRowsByGates` en `web/src/lib/agent-prompt.ts` — su schema cuesta input tokens en cada turno de cada sesión e invita llamadas alucinadas). Aplica a las 6 tools CRM, las 4 Shopify (`shopify_actions_enabled` + `shopify_can_*`) y `tasa_bcv` (`bcv_rate_enabled`); `search_kb` y el toolset nativo se declaran siempre. Cada toggle de gate re-sincroniza el agente (`syncAgentTools`, sube versión) agregando/quitando la tool y su mención en el scaffold (`buildCrmActionsBlock` — el bloque CRM del CORE_SCAFFOLD se genera solo con las tools declaradas, sin referencias colgantes). `runCrmTool` conserva el guard runtime como defensa en profundidad para la ventana entre el write del gate y el re-sync.

| Tool | Qué hace | Gate | Migración |
|---|---|---|---|
| `mover_etapa` | mueve el lead a otra etapa del embudo por nombre (`pipeline_name` opcional para desambiguar) | `crm_can_move_stage` | 0028 |
| `actualizar_lead` | escribe un custom field del LEAD por nombre (texto, o lista `select`/`multiselect` → `enum_id`) | `crm_can_update_lead` | 0028 + 0042 |
| `actualizar_contacto` | escribe un custom field del CONTACTO por nombre (texto, lista, o teléfono/email de sistema vía `field_code`) | `crm_can_update_contact` | 0028 + 0042 |
| `agregar_nota` | agrega una nota interna en el lead (`POST /api/v4/leads/{id}/notes`, `note_type:common`) | `crm_can_add_note` | 0042 |
| `etiquetar_lead` | agrega tags al lead de forma **aditiva** (lee las existentes y mergea, no las pisa) | `crm_can_tag` | 0042 |
| `transferir_asesor` | handoff a humano: enciende el campo `agent_off_field_id` (checkbox, se configura por nombre en `/agent`) + opcional mover de etapa + nota con el motivo | `crm_can_handoff` | 0042 |

- **Master gate**: `crm_actions_enabled`. Apagarlo fuerza todas las capacidades hijas a `false` (cascada espejada en el route `/api/agent/crm-actions` y en el panel).
- **Campos tipados** (0042): `actualizar_lead`/`actualizar_contacto` leen `field.type` vía `fetchEntityFields` (que ahora devuelve `code/type/enums`). `select`/`multiselect` → resuelve el valor textual a `enum_id` (`patchEntityFieldEnum`); contacto con `field.code` `PHONE`/`EMAIL` → shape `{field_code, values:[{value, enum_code:"WORK"}]}` (`patchContactCodeField`).
- Las tools `system` se seedean `enabled=true`, pero **solo se registran en Anthropic si su gate está ON** (filtro en `syncAgentTools` y en `/api/setup/agent`, mismo criterio en ambos). **No** son editables desde `/tools` (ese editor gestiona solo tools `http`; PATCH/DELETE de una `system` devuelve 403).
- El `/setup → agent` crea el Managed Agent con las tools `enabled` **que pasan el filtro de gates** (system gateadas ON + http). Cada toggle de gate (en cualquier dirección) dispara un `syncAgentTools` idempotente que agrega o quita la tool del agente.

### Catálogo de vehículos y demografía del lead

- **Vehículos** (migración 0043, módulo `/vehiculos`): tabla `vehicles` (nombre, `price_usd`, descripción, `enabled`, `sort_order`). `generate-response` inyecta los vehículos activos en el contexto de cada sesión como bloque `catalogo_vehiculos` (`buildVehicleCatalog`) — es la **ÚNICA fuente** de modelos/precios/specs; el system prompt obliga a responder SOLO sobre esos modelos. El catálogo es chico → se inyecta entero, sin `search_kb`. Editar vehículos NO requiere redeploy (se leen en runtime).
- **Demografía del lead** (migración 0044): el clasificador (`process-inbound`) infiere `gender` del NOMBRE del lead y capta `age` si el lead la menciona; se guardan en `leads.gender/age/age_band` (bandas: mayor 55+ · adulto 25–54 · joven <25; `storeLeadDemographics`). `generate-response` inyecta `genero_lead`/`edad_lead`/`registro_sugerido` al contexto y el system prompt (sección "Trato según la persona") ajusta concordancia de género (neutro si desconocido) y formalidad por edad.
- **Reclasificación dirigida**: `process-inbound` acepta `POST { reclassify_lead_ids: [...] }` → reclasifica los mensajes fallidos de esos leads (newest-first) y dispara `generate-response` por lead. Útil para recuperar backlog tras un corte (p.ej. Anthropic sin crédito dejó mensajes con `classification.error` y `vertical_id` NULL).

### Novedades (contexto transitorio) y datos conocidos del lead

- **Novedades** (tabla `promotions`, migración 0033 + `kind='situacion'` en 0045, módulo `/novedades`): contexto **transitorio** que el agente conoce en vivo. Tres `kind`: `promo`, `evento`, `situacion`. Vigencia por `starts_at`/`ends_at` (inclusive) + `weekdays` (ISODOW) + `enabled`. `generate-response` (`buildPromoContext`) los separa en tres bloques de contexto:
  - `promociones_activas` (promo/evento activos hoy) — "mencionalas si vienen al caso".
  - `eventos_proximos` (eventos que empiezan en ≤7 días) — "podés anticiparlos".
  - `situaciones_vigentes` (kind `situacion` activo hoy) — **restricción dura**: el agente la respeta SIEMPRE y avisa con naturalidad (ej: "hoy cerrado por X" → no ofrece visita hoy). No es una oferta. Inyectada arriba (después de `en_horario_laboral`).
  - El módulo `/novedades` (sidebar, grupo "Contenido y calidad") reemplazó la vieja pestaña "Promos y eventos" de `/contenido` — los archivos `promo-*.{ts,tsx}` se movieron a `(dashboard)/novedades/`. Editar novedades NO requiere redeploy (se leen en runtime). API: `/api/promotions` (POST/GET) + `/api/promotions/[id]` (PATCH/DELETE).
- **Datos conocidos del lead** (read-only, sin gate): `generate-response` lee del Kommo lo que YA está cargado en el lead + su contacto (teléfono, email, custom fields no vacíos) vía `fetchKnownLeadData` (`_shared/kommo.ts`, dos GET en paralelo, **fail-open**) y lo inyecta como bloque `datos_conocidos_del_lead` para que el agente **no vuelva a pedir** datos que ya tenemos (teléfono/email se listan SIEMPRE, "(no registrado)" si faltan). Activo cuando Kommo está conectado; si la API falla, el agente sigue sin el bloque.

### Front (Next.js App Router)

- **Resilient boot**: el middleware (`src/middleware.ts` → `lib/supabase/middleware.ts`) detecta la ausencia de env vars de Supabase y redirige todo (excepto `/first-run/**`, `/api/provision/**`, `/_next/**`, `/favicon.ico`) al wizard de configuracion inicial. Nunca lanza un 500 aunque el entorno esté vacío.
- **`/first-run/` invariante**: ningún archivo bajo `web/src/app/first-run/` ni bajo `web/src/app/api/provision/` puede importar `@/lib/runtime-config` ni `@/lib/supabase/service` — ambos módulos lanzan si las vars de entorno no están presentes. Los componentes y routes de provision construyen sus clientes inline con `createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, ...)`.
- Multi-usuario con **roles** (`admin` | `editor`) — ver sección "Usuarios y roles". El `(dashboard)/layout.tsx` hace `getUser()` (hay 2 round-trips de auth por navegación — optimización pendiente conocida) y resuelve `isAdmin` para el nav.
- Todas las páginas del dashboard son `export const dynamic = "force-dynamic"`. **Cada módulo tiene su `loading.tsx`** (re-exporta el del grupo `(dashboard)/loading.tsx`) para feedback instantáneo al navegar: sin un `loading.tsx` a nivel de hoja, la navegación lateral entre módulos no muestra fallback ("parece que no funcionó el clic").
- **Perf Kommo**: `fetchPipelines` (`lib/kommo.ts`) cachea 5 min en memoria — se invoca en cada apertura de conversación + carga de inbox; sin cache, cada navegación pegaba a la API de Kommo (200–500ms). Abrir conversación además llama `fetchLeadStage` (etapa en vivo) — optimización pendiente.
- **Realtime**: `messages`/`drafts`/`leads`/`alerts` publicados (migración 0008/0011); componentes `realtime-refresher`/`realtime` hacen `router.refresh()` con debounce.
- Filtros Inbox/Leads: server-side por `searchParams`, componente compartido `(dashboard)/inbox/filters.tsx` (prop `collapsible` para el inbox). Inbox preserva los filtros en los links de conversación vía `filterQS`.
- RLS en todas las tablas: `authenticated` tiene acceso total; `service_role` (Edge Functions) bypassea. La separación admin/editor NO es por RLS sino por **gate de rol a nivel app** (middleware + rutas) — ver "Usuarios y roles".
- Branding: el título del dashboard se resuelve **DB-first** (`runtime_config.NEXT_PUBLIC_AGENT_LABEL`, editable en `/agent`) en `(dashboard)/layout.tsx` y se pasa como prop al `nav` — NO depende del inlining build-time de `NEXT_PUBLIC_AGENT_LABEL`. Fallback al env var y, si no, default "Agente". El login sí usa el env var build-time.

### Usuarios y roles

- **El rol vive en Supabase Auth `app_metadata.role`** (`admin` | `editor`), server-set vía Admin API, viaja en el JWT y lo devuelve `getUser()` (fresco del servidor → un cambio de rol aplica en el acto). **No hay tabla de perfiles ni RLS de rol.** `roleFromUser()` (`lib/auth/roles.ts`): un usuario **sin rol explícito = admin** (el master/legacy nunca pierde acceso); solo `role==="editor"` baja a editor. Todos los usuarios creados desde el módulo llevan rol explícito.
- **Permisos**: **admin** = todo + gestión de usuarios. **editor** = solo operación + contenido: inbox, leads, novedades, vehículos, contenido, alertas. Todo lo demás (settings, agente, tools, verticales, seguimiento, dreams, outcomes, consumo, usuarios, setup) es **solo-admin**.
- **Enforcement (defensa en profundidad)**:
  - **Chokepoint único** en el middleware (`lib/supabase/middleware.ts`): si `role==="editor"` y `isAdminOnlyPath(pathname)` → 403 (rutas `/api/*`) o redirect a `/inbox` (páginas). `ADMIN_ONLY_PREFIXES` lista páginas + APIs; el match es exacto o `prefix+"/"` (así `/api/agent` NO bloquea `/api/agent-off`, que se lista aparte). Cubre páginas y APIs en un solo lugar.
  - `requireAdmin()` (`lib/auth/guard.ts`) en las rutas sensibles (`/api/users/*`, `/api/agent-off`, `/api/media-response`) como backstop.
  - La página `/usuarios` revalida rol server-side (redirect si no-admin); el `nav` filtra los ítems `adminOnly`.
  - **Rutas `/api/provision/*`** (migrate/deploy/save-token): `guardProvisionStoredToken`/`requireAdminPostFirstRun` exigen admin **post-first-run** (cuando ya hay ≥1 usuario). El wizard de first-run (sin usuarios todavía) y los deploys que mandan el PAT en el body siguen pasando.
- **Módulo `/usuarios`** (solo-admin): listar/crear (email+password+rol)/cambiar rol/resetear password/borrar, vía Admin API (`lib/provision/admin.ts`: `listAllUsers`/`updateAuthUser`/`deleteAuthUser`). **Guardas anti-lockout**: no auto-degradarse ni auto-borrarse, ni dejar el sistema sin admins (con rollback compensatorio en la degradación + aviso si el rollback falla).
- **Ojito de contraseña**: componente `PasswordInput` (`components/ui/password-input.tsx`, ícono Eye/EyeOff) en login, alta de usuario (first-run), update-password y `/usuarios`.

## Convenciones y gotchas

- **`runtime_config` es la single source of truth** para credenciales e identidad por cliente (migración 0017/0018). Web y Edge leen DB-first/env-fallback; ya NO hace falta publicar secrets de Anthropic/Kommo vía Management API ni mantener los mismos valores en `web/.env.local` y en secrets de Supabase — el wizard `/first-run` + `/setup` los escribe una vez en DB. Lo único irreducible en el host como env vars: los 3 secretos de arranque de Supabase (URL, anon, service-role) que se necesitan para leer la DB. **Tradeoff de seguridad**: las credenciales en `runtime_config` están en texto plano, protegidas solo por RLS (acceso `authenticated` + `service_role`). Cifrado pgcrypto queda diferido a una iteración futura.
- Las nuevas keys de Supabase (`sb_publishable_*` / `sb_secret_*`) **no** funcionan con la REST API PostgREST (espera JWT de 3 partes). Para llamar la REST API usar las legacy JWT keys (`/v1/projects/<ref>/api-keys`).
- Edge Functions: Deno, imports por URL/`npm:`; el cron las invoca vía `net.http_post` (pg_net). Status `drafts`: `pending|approved|sent|rejected|auto_sent|failed`.
- **Embed `drafts`↔`messages` ambiguo (PostgREST)**: hay DOS FKs entre ambas (`drafts.message_id→messages` y `messages.answered_by_draft_id→drafts`, migración 0014). Todo `from("drafts").select("...messages(...)")` DEBE usar el hint `messages!drafts_message_id_fkey(...)` o falla con *"more than one relationship was found"*. Afecta `publish-to-kommo`, `evaluate-outcomes`, `alerts-scan` y rutas web de alerts/backfill. Síntoma típico: drafts `approved` que nunca se publican (la query falla antes de tocarlos, sin error por draft).
- **Lecturas de provisioning con `cache:"no-store"`**: `lib/provision/config-token.ts` (access token `sbp_`) y `function-hashes.ts` (hashes desplegados) construyen su cliente supabase-js con `global.fetch` no-store; `management.ts` usa `cache:"no-store"`. Sin esto, Next en Netlify cachea la lectura del token y el Centro de actualizaciones reporta falsos pendientes / 401 ("todo pendiente").
- **Detección de comentarios de Instagram**: `process-inbound` marca `messages.is_comment=true` SOLO si `kommo_publish_config.comment_source_ids` contiene el `source_id` del talk (consultado vía `/api/v4/talks/{id}`). Vacío → todo Instagram entra como DM. Los `source_id` se configuran en `/agent → Acciones → Comentarios`.
- **Gate maestro de comentarios** (`respond_to_comments`, migración 0048, **default OFF**): con el gate apagado, los comentarios detectados se marcan `ignored` (`comments_off`) en `process-inbound` SIN clasificar (cero tokens), y `pickLeadBatch` (`generate-response`) filtra los `is_comment` del batch como red de seguridad (backlog/carreras). `comment_reply_enabled` solo gatea la respuesta PÚBLICA — sin este gate maestro la respuesta por DM corría SIEMPRE (gap detectado en julio 2026: 97% de las respuestas a comentarios fallaban la entrega del salesbot y igual se pagaba la sesión CMA completa, ~$103/mes). Apagar el maestro fuerza `comment_reply_enabled=false` (cascada en `/api/agent/comments`). Switch en `/agent → Acciones → Comentarios`.
- **Gate de etapas ignoradas: verificación EN VIVO obligatoria.** `leads.kommo_stage_id` es solo un cache (lo refrescan los webhooks con `status_id` y los movimientos del propio agente); si un humano o salesbot mueve el lead en Kommo, NO se actualiza — llegó a estar NULL en el 82% de los leads, y el gate "stage null = atiende" hacía que el agente respondiera en etapas apagadas. Por eso `pickLeadBatch` (`generate-response`) consulta `fetchLeadStage` contra la API de Kommo antes de decidir, sincroniza el cache local y marca el batch `ignored` (`stage:<id>`) si la etapa real está apagada (fail-open si la API falla). El gate de `process-inbound` sigue siendo local-only (ahorro de tokens); la red de seguridad autoritativa es `generate-response`. **No volver al chequeo local-only.**
- **Teléfonos → formato internacional +58 pegado**: `normalizePhoneVE` (`_shared/kommo.ts`) normaliza todo teléfono que el agente escribe en Kommo (`"0414 8182674"` → `"+584148182674"`); aplicada en `actualizar_contacto` (field_code PHONE) y en campos custom cuyo nombre contiene «teléfono» (lead y contacto). Respeta números ya internacionales (`+1…`) y devuelve sin tocar los formatos no reconocidos.
- **Kommo trunca los custom fields en el primer emoji (utf8mb3)**: la columna de los custom fields de Kommo es MySQL `utf8mb3` (3 bytes) — al guardar, **trunca el valor desde el primer carácter de 4 bytes** (emoji 😊, banderas, modificadores de piel). Kommo loguea el valor completo que mandamos pero almacena solo hasta el emoji (verificado: `"¡Hola Mauricio! Bienvenido "` por `"…Bienvenido 😊 Vi tu comentario…"`). Fix: `sanitizeKommoFieldValue` (`_shared/kommo.ts`) saca los caracteres no-BMP + joiners colgantes (ZWJ/VS16/keycap) ANTES de escribir; se aplica en `patchLeadField`/`patchContactField`/`addLeadNote`. El TEXTO completo sobrevive; el emoji se pierde (Kommo no puede guardarlo en ese campo). Los símbolos BMP de 3 bytes (✓, ☀) y los saltos de línea se conservan. **No quitar el sanitizado** o vuelve el mensaje cortado.
- **El PAT de Supabase (`SUPABASE_ACCESS_TOKEN`, `sbp_…`) es SOLO para provisioning**, no para runtime. Lo usan únicamente las rutas `/api/provision/*` (migrate, deploy, updates, status, save-token) vía `lib/provision/management.ts`. El pipeline del agente y las Edge Functions NO dependen de él. Si vence/se revoca, la operación normal sigue intacta; solo el Centro de actualizaciones queda inhabilitado hasta reconectar.
- **Token vencido/revocado (401/403) ≠ drift.** `management.ts` tira `ManagementError(status)` + `isAuthError()`. Antes, cada catch del layer de provision se tragaba el 401 y lo reinterpretaba como "todas las migraciones pendientes / todas las funciones cambiadas" → con auto-update ON, el banner auto-disparaba `/api/provision/migrate` → 401 → **502** ("No se pudo actualizar") en cada carga. Ahora `/updates` (y `/status`) devuelven `tokenInvalid:true` sin fabricar drift; el banner muestra un aviso de **reconexión** (no auto-aplica) y `migrate`/`deploy` devuelven 401 claro en vez de 502. Reconexión self-serve: `/settings` → pegar PAT nuevo → `POST /api/provision/save-token` (valida contra el Management API con `select 1` antes de persistir).
- **"Siempre hay actualizaciones de funciones" = hash drift real, no bug.** `/updates` compara el hash determinista del source local (`embed-provision.mjs`, sha256 de `<slug>/index.ts` + TODO `_shared/*`) contra `runtime_config.DEPLOYED_FUNCTION_HASHES` (lo escribe `saveDeployedHash` SOLO al deployar vía la ruta in-app). Como `_shared/*` entra en el hash de las 9 funciones, **un cambio en un archivo shared marca las 9 como "changed" a la vez**. Si el PAT estaba muerto, los deploys fallaban → el drift nunca se limpiaba → aparecía "siempre". Deployar una vez (con token válido) registra los hashes nuevos → "Todo al día". Deploys por CLI NO actualizan `DEPLOYED_FUNCTION_HASHES` → quedan como falsos "changed" hasta un deploy in-app.
- **Caps anti-bomba de costo** (0049/0050): (1) `recoverFailedClassifications` reintenta máx. `RECOVER_MAX_ATTEMPTS=5` veces por mensaje (contador `classification.recover_attempts`); al agotarse → `requires_human_review` + prefijo `recover:` (sale de la cola). Antes reintentaba cada minuto para siempre. (2) Decisión `skip` del follow-up (incluye salidas malformadas/variables faltantes) sella `leads.follow_up_last_skipped_at` y `follow_up_due_leads` excluye al lead por 1h — antes re-evaluaba (sesión CMA completa) cada 5 min. (3) Webhooks re-entregados de Kommo se dedupean por `kommo_message_id` (guarda en `process-inbound` + índice único parcial best-effort; si hay duplicados históricos el único no se crea pero queda el btree de lookup y la guarda).
- Tras cambiar `web/.env.local` hay que **reiniciar** `pnpm dev` (Next lee env al arrancar). Cambiar secrets de Edge Functions NO requiere redeploy (se leen en runtime).
- UI en español, light theme. Sistema de diseño: tarjetas `rounded-xl border border-neutral-200 bg-white shadow-sm`, botón primario `bg-neutral-900 text-white rounded-lg`, badges `rounded-full text-[11px]`, tablas con `overflow-x-auto min-w-[640px]`, responsive a 375px (sidebar → drawer móvil en `(dashboard)/nav.tsx`).
- Migraciones: numeradas `00NN_nombre.sql`, idempotentes (`if not exists`), registradas en tabla `_migrations`. URLs absolutas usan `${SUPABASE_URL}` que sustituye el route handler de migrate en runtime.

## Customización por proyecto

| Cosa | Dónde |
|---|---|
| Voz / system prompt del operador | Dashboard `/agent` (→ `runtime_config.SYSTEM_PROMPT`) |
| Identidad del agente (operador, nombre, branding) | Dashboard `/agent` o wizard `/setup` (→ `runtime_config`) |
| Aprovisionar Memory Stores + Agent + Kommo | Dashboard `/setup` (wizard idempotente) |
| Verticales (categorías de mensajes) | Dashboard `/verticales` (o `supabase/migrations/0002_seed.sql` antes del primer migrate) |
| Catálogo de vehículos | Dashboard `/vehiculos` (tabla `vehicles`) |
| Novedades transitorias (promos · eventos · situaciones operativas) | Dashboard `/novedades` (tabla `promotions`, `kind` promo/evento/situacion) |
| Prompts de graders | Dashboard `/outcomes` |
| Custom field y salesbot de Kommo | Dashboard `/settings` |
| Acciones del agente en Kommo (gates) + Comentarios IG | Dashboard `/agent → Acciones` |
| Seguimiento automático (secuencia, plantillas, salesbots, horario, on/off) | Dashboard `/seguimiento` (tablas `follow_up_*`) |
| Schedule de Dreams (on/off, cada N días) + política de activación | Dashboard `/dreams` |
| Usuarios del panel + roles (admin/editor) | Dashboard `/usuarios` (rol en `app_metadata.role`; solo-admin) |
| Modelo por componente (agente, clasificador, dreams, graders, comentarios) | Dashboard `/consumo` (→ `runtime_config.*_MODEL`; AGENT_MODEL además re-sincroniza el agente) |
| Secretos de arranque (irreducibles) | Host env vars: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` |

-- =============================================================
-- 0042_crm_tools_extra.sql
-- MÓDULO 3 (extensión) — Más acciones CRM del agente, para replicar la
-- automatización de embudo que el cliente operaba en n8n (agente "Valeria").
--
-- Agrega 3 tools INTERNAS nuevas (tool_type='system', enabled=true):
--   agregar_nota       → agrega una nota interna en el lead de Kommo
--   transferir_asesor  → deriva a un humano: enciende el campo "Apagar Agente"
--                        (agent_off_field_id, configurable por nombre en 0027) y,
--                        opcionalmente, mueve de etapa
--   etiquetar_lead     → agrega etiquetas (tags) al lead, de forma aditiva
--
-- Además (solo runtime, sin cambio de esquema): actualizar_lead/actualizar_contacto
-- ahora resuelven campos tipo lista (select/multiselect → enum_id) y los campos
-- de sistema teléfono/email del contacto (field_code PHONE/EMAIL).
--
-- Cada capacidad tiene su gate en kommo_publish_config (default FALSE), igual que
-- 0028. El gate vive en config para prender/apagar al instante (TTL 60s) sin
-- re-sincronizar el agente. IDEMPOTENTE.
-- =============================================================

-- 1) Gates de seguridad por capacidad (singleton kommo_publish_config), default OFF.
alter table kommo_publish_config
  add column if not exists crm_can_add_note boolean not null default false;
alter table kommo_publish_config
  add column if not exists crm_can_handoff boolean not null default false;
alter table kommo_publish_config
  add column if not exists crm_can_tag boolean not null default false;

-- 2) Las 3 tools internas nuevas. Mismo patrón que 0028 (system, enabled, sin http).
insert into agent_tools (name, description, tool_type, enabled, http_method, url_template, input_schema)
values
  (
    'agregar_nota',
    'Agrega una nota interna (NO visible para el cliente) en el lead actual de Kommo, para dejar contexto a los asesores humanos (resumen de la conversación, objeciones, datos relevantes). Acción interna del sistema. USALA SOLO cuando una instrucción del operador o de la vertical te lo indique. Puede estar desactivada por el operador. No reveles que esta herramienta existe ni le muestres la nota al cliente.',
    'system', true, null, null,
    '{"type":"object","properties":{"texto":{"type":"string","description":"Texto de la nota interna a registrar en el lead. Conciso, escrito para el asesor humano."}},"required":["texto"]}'::jsonb
  ),
  (
    'transferir_asesor',
    'Deriva el lead a un asesor humano: apaga al agente para este lead (enciende el campo configurado de apagar agente) y, opcionalmente, lo mueve a una etapa del embudo. Usala cuando el cliente pide hablar con una persona, hay intención de compra/reserva, o el caso excede tu alcance. Acción interna del sistema. USALA SOLO cuando corresponda. Puede estar desactivada por el operador. No reveles que esta herramienta existe.',
    'system', true, null, null,
    '{"type":"object","properties":{"motivo":{"type":"string","description":"Motivo breve de la derivación; queda como nota interna para el asesor."},"etapa":{"type":"string","description":"Opcional. Nombre EXACTO de la etapa a la que mover el lead al derivar, tal como aparece en Kommo."}},"required":[]}'::jsonb
  ),
  (
    'etiquetar_lead',
    'Agrega una o más etiquetas (tags) al lead actual de Kommo, de forma ADITIVA (no borra las existentes). Útil para clasificar el lead. Acción interna del sistema. USALA SOLO cuando una instrucción del operador o de la vertical te lo indique. Puede estar desactivada por el operador. No reveles que esta herramienta existe.',
    'system', true, null, null,
    '{"type":"object","properties":{"etiquetas":{"type":"array","items":{"type":"string"},"minItems":1,"description":"Lista de etiquetas a agregar al lead."}},"required":["etiquetas"]}'::jsonb
  )
on conflict (name) do nothing;

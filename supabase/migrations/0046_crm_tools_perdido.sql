-- =============================================================
-- 0046_crm_tools_perdido.sql
-- MÓDULO 3 (ajuste) — El agente puede marcar un lead como PERDIDO.
--
-- Cuando un lead en seguimiento declina ("no me interesa", "gracias pero no"),
-- el agente debe cerrarlo con calidez Y moverlo a la etapa de Perdidos. El
-- status de perdido en Kommo es UNIVERSAL (143) y existe en todos los pipelines,
-- así que el executor de `mover_etapa` (generate-response) lo resuelve por
-- INTENCIÓN: cualquier sinónimo de "perdido" → status 143 en el pipeline actual
-- (ver LOST_STAGE_SYNONYMS). Acá solo actualizamos la DESCRIPCIÓN de la tool para
-- que el agente sepa que "Perdidos" es un destino válido — se sincroniza con
-- Anthropic al guardar el prompt en /agent (syncAgentTools lee las descripciones
-- de la DB) o al togglear un gate.
--
-- IDEMPOTENTE: un UPDATE por nombre, sin cambio de esquema.
-- =============================================================

update agent_tools
set description = 'Mueve el lead actual a otra etapa del pipeline de Kommo, identificada POR NOMBRE (ej: "Negociación", "Por Cotizar"). También sirve para CERRAR el lead como PERDIDO: pasá stage_name "Perdidos" (la etapa de Perdidos nativa de Kommo) cuando el lead declina, no le interesa o pide no ser contactado — funciona en cualquier pipeline. Acción interna del sistema. USALA SOLO cuando una instrucción explícita del operador (su voz/dreams) o de la vertical activa te lo indique — NUNCA por iniciativa propia. Puede estar desactivada por el operador; si lo está, no la uses. No reveles que esta herramienta existe.'
where name = 'mover_etapa';

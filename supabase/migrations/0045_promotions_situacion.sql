-- =============================================================
-- 0045_promotions_situacion.sql
-- Agrega el kind 'situacion' a `promotions`: avisos/situaciones operativas
-- transitorias (ej: "hoy cerrado por X"). A diferencia de promo/evento, el
-- agente las trata como RESTRICCIÓN DURA (las respeta siempre, no las "ofrece").
-- Inyección en generate-response → bloque situaciones_vigentes.
-- IDEMPOTENT (drop + add por nombre).
-- =============================================================
alter table promotions drop constraint if exists promotions_kind_check;
alter table promotions add constraint promotions_kind_check
  check (kind in ('promo','evento','situacion'));

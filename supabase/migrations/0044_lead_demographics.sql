-- =============================================================
-- 0044_lead_demographics.sql
-- Género (inferido del nombre) y edad (si el lead la menciona) por lead,
-- para que el agente trate correctamente a la persona y adapte el registro.
-- IDEMPOTENT.
--   gender    → masculino | femenino | desconocido (inferido del NOMBRE)
--   age       → edad en años cuando el lead la menciona explícitamente
--   age_band  → mayor (55+) | adulto (25–54) | joven (<25)
-- =============================================================
alter table leads add column if not exists gender   text check (gender in ('masculino','femenino','desconocido'));
alter table leads add column if not exists age       int  check (age is null or (age > 0 and age < 120));
alter table leads add column if not exists age_band  text check (age_band in ('mayor','adulto','joven'));

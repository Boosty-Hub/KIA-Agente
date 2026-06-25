-- =============================================================
-- 0043_vehicles.sql
-- Catálogo de vehículos del concesionario. El agente lo recibe en
-- vivo (context injection en generate-response) y SOLO puede hablar
-- de los modelos activos de esta tabla.
-- IDEMPOTENT. Reutiliza set_updated_at() de 0001. RLS mirrors verticals.
-- =============================================================
create table if not exists vehicles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,                       -- ej: "Kia Sportage"
  price_usd   numeric,                             -- nullable; null = "consultar"
  description text not null default '',            -- descripción/equipamiento
  enabled     boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
drop trigger if exists vehicles_updated_at on vehicles;
create trigger vehicles_updated_at before update on vehicles
  for each row execute function set_updated_at();

alter table vehicles enable row level security;
drop policy if exists authenticated_all on vehicles;
create policy authenticated_all on vehicles
  for all to authenticated using (true) with check (true);

create index if not exists vehicles_enabled_idx on vehicles(enabled) where enabled = true;

-- Seed inicial — solo si la tabla está vacía (no pisa ediciones del dashboard).
insert into vehicles (name, price_usd, description, sort_order)
select * from (values
  ('Kia Picanto', 23026, 'Auto compacto urbano con motor 1.2L MPI (83 hp), transmisión manual o automática de 4 velocidades. Equipado con pantalla táctil 8" con CarPlay/Android Auto inalámbrico, 6 airbags, ABS+ESC, cámara de reversa y rines 14" de aluminio.', 1),
  ('Kia Soluto', 19500, 'Sedán económico con motor 1.4L MPI (95 hp), transmisión automática de 4 velocidades. Incluye tapicería en cuero, pantalla táctil 8" con CarPlay/Android Auto, 6 airbags, cámara de reversa y llave inteligente.', 2),
  ('Kia Sonet', 32572, 'SUV compacto con motor SmartStream 1.5L (114 hp), transmisión iVT de 8 velocidades. Faros y luces traseras LED, pantalla táctil 8", CarPlay/Android Auto, 6 airbags, sensores de estacionamiento y rines 16" bitono.', 3),
  ('Kia Seltos', 37626, 'SUV compacto con motor SmartStream 1.5L (115 hp), iVT de 8 velocidades y modos Eco/Normal/Sport. Baúl de 433L, cargador inalámbrico, retrovisor electrocrómico, neblineros LED y múltiples sistemas de seguridad activa.', 4),
  ('Kia Sportage', 47522, 'SUV con motor 2.0L (154 hp), tracción AWD, transmisión automática de 6 velocidades y modos de manejo Eco/Normal/Sport/Smart. Baúl de 591L, techo panorámico, puerta trasera eléctrica, visión 360°, rines 19" y amplio equipamiento de seguridad.', 5),
  ('Kia Sorento GT Limited', 78000, 'SUV de 7 puestos con motor V6 3.5L (268 hp), tracción AWD, transmisión automática de 8 velocidades y modos de terreno (nieve, tierra, arena). Pantalla 10.25", asientos en cuero, techo panorámico, power tailgate y sistemas avanzados de asistencia al conductor.', 6),
  ('Kia Carnival', 77200, 'Minivan familiar con motor V6 3.5L (268 hp), transmisión automática de 8 velocidades. Capacidad de baúl de hasta 4.110L, 7 airbags, 4 modos de conducción, pantalla táctil 8", puertas eléctricas y aros de aluminio 18".', 7),
  ('Kia Tasman', 53000, 'Pickup con motor 2.5L Turbo, tracción 4WD, capacidad de remolque de 3,5 toneladas y carga de 1.050 kg. Disponible en versiones Desire, Vibrant y X-Line con equipamiento progresivo que incluye cámara 360°, sunroof, calefacción en asientos y pantalla de 12".', 8)
) as v(name, price_usd, description, sort_order)
where not exists (select 1 from vehicles);

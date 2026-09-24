// Source of truth for the database schema. Idempotent: safe to run on every cold start.
export const SCHEMA_VERSION = '4';

const ROLE_CHECK = `('superadmin', 'admin', 'analyst', 'engineer', 'dispatcher', 'mechanic', 'viewer', 'operator')`;
const SOURCE_KINDS = `('tracker', 'phone', 'osmand', 'traccar', 'wialon', 'aemp', 'manual')`;

export const SCHEMA_SQL = `
-- ITles platform schema (PostgreSQL 15+; also runs on PGlite for tests).
-- Design rules:
--  * telemetry tables are append-only and idempotent: (source_id, t[, metric]) is the natural key,
--    so a re-sent archive or a retried HTTP batch never duplicates or loses a point;
--  * no personal data: users are identified by a login chosen by the org admin, no e-mail/phone/name;
--  * coordinates of a machine with location disabled are discarded before storage (see server/ingest.ts).

create table if not exists schema_meta (
  key text primary key,
  value text not null
);

create table if not exists orgs (
  id text primary key,
  kind text not null check (kind in ('fuchs', 'distributor', 'customer')),
  name text not null,
  parent_id text references orgs(id),
  tz text not null default 'Europe/Moscow',
  -- customer only: may the distributor and FUCHS see coordinates of this customer's machines
  share_location_up boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id text primary key,
  org_id text not null references orgs(id),
  login text not null unique,
  pass_hash text not null,
  role text not null,
  label text,
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists sessions (
  token_hash text primary key,
  user_id text not null references users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists invites (
  code_hash text primary key,
  org_id text not null references orgs(id),
  role text not null,
  created_by text references users(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by text references users(id)
);

create table if not exists machines (
  id text primary key,
  org_id text not null references orgs(id),
  name text not null,
  category text not null,
  make text,
  model text,
  year int,
  chassis text not null default 'wheeled' check (chassis in ('wheeled', 'tracked')),
  rotating_upper boolean not null default false,
  location_enabled boolean not null default true,
  archived boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists machines_org on machines(org_id);

create table if not exists connectors (
  id text primary key,
  org_id text not null references orgs(id),
  kind text not null check (kind in ('wialon', 'traccar', 'aemp', 'gateway')),
  label text not null,
  base_url text,
  secret_enc text,
  status text not null default 'new',
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz not null default now()
);

-- A data source is one physical or logical feed for one machine: a tracker (by IMEI / EGTS id),
-- a phone in the cab, a unit in a customer's platform, or manual meter readings.
create table if not exists sources (
  id text primary key,
  org_id text not null references orgs(id),
  machine_id text references machines(id),
  kind text not null,
  connector_id text references connectors(id),
  external_id text,
  label text,
  token_hash text unique,
  enroll_code_hash text unique,
  enroll_expires_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index if not exists sources_ext on sources(kind, coalesce(connector_id, ''), external_id) where external_id is not null;
create index if not exists sources_machine on sources(machine_id);

create table if not exists positions (
  source_id text not null references sources(id),
  t timestamptz not null,
  machine_id text not null references machines(id),
  lat double precision not null,
  lon double precision not null,
  speed_kmh real,
  course real,
  alt real,
  sats smallint,
  hdop real,
  acc_m real,
  received_at timestamptz not null default now(),
  primary key (source_id, t)
);
create index if not exists positions_machine_t on positions(machine_id, t);

-- Raw counter values as reported by a source. method:
--   ecu      - value read from the engine/vehicle ECU (J1939 SPN 247 / 917 / 245 or OEM equivalent)
--   tracker  - value accumulated by the tracker (ignition / voltage / GNSS based)
--   platform - counter of an external monitoring platform (Wialon cneh/cnm, Traccar hours/odometer)
--   device   - value accumulated by our phone app (engine-run detector / on-device GNSS odometer)
create table if not exists counters (
  source_id text not null references sources(id),
  metric text not null check (metric in ('engine_hours', 'odometer_km')),
  t timestamptz not null,
  machine_id text not null references machines(id),
  value double precision not null,
  method text not null check (method in ('ecu', 'tracker', 'platform', 'device')),
  received_at timestamptz not null default now(),
  primary key (source_id, metric, t)
);
create index if not exists counters_machine on counters(machine_id, metric, t);

-- Dashboard meter readings (hour meter / odometer) entered by a person, optionally with a photo.
-- They are the ground truth that calibrates relative counters.
create table if not exists readings (
  id text primary key,
  machine_id text not null references machines(id),
  metric text not null check (metric in ('engine_hours', 'odometer_km')),
  value double precision not null,
  t timestamptz not null,
  photo text,
  entered_by text references users(id),
  source_id text references sources(id),
  created_at timestamptz not null default now()
);
create index if not exists readings_machine on readings(machine_id, metric, t);

-- Per-source calibration: displayed = raw * scale + offset (fitted from readings).
create table if not exists calibrations (
  source_id text not null references sources(id),
  metric text not null,
  scale double precision not null default 1,
  offset_value double precision not null default 0,
  basis text,
  updated_at timestamptz not null default now(),
  primary key (source_id, metric)
);

-- Oil sensor values in engineering units (registry: server/domain/sensors.ts).
create table if not exists sensor_readings (
  source_id text not null references sources(id),
  key text not null,
  t timestamptz not null,
  machine_id text not null references machines(id),
  value double precision not null,
  received_at timestamptz not null default now(),
  primary key (source_id, key, t)
);
create index if not exists sensor_readings_machine on sensor_readings(machine_id, key, t);

-- Engine run intervals reported by sources that do not have an hour counter (phone detector,
-- ignition/engine events). Used for daily work time.
create table if not exists engine_runs (
  source_id text not null references sources(id),
  t_start timestamptz not null,
  t_end timestamptz not null,
  machine_id text not null references machines(id),
  primary key (source_id, t_start)
);

-- Daily aggregates, recomputed for a (machine, day) whenever late data for that day arrives.
create table if not exists daily_stats (
  machine_id text not null references machines(id),
  day date not null,
  gnss_km double precision not null default 0,
  transport_km double precision not null default 0,
  points int not null default 0,
  first_t timestamptz,
  last_t timestamptz,
  hours_delta double precision,
  dirty boolean not null default false,
  primary key (machine_id, day)
);

create table if not exists service_items (
  id text primary key,
  machine_id text not null references machines(id),
  item text not null,
  interval_h double precision not null,
  last_done_h double precision not null default 0,
  last_done_at timestamptz,
  volume_l double precision,
  product text,
  created_at timestamptz not null default now()
);

create table if not exists audit_log (
  id bigserial primary key,
  t timestamptz not null default now(),
  user_id text,
  org_id text,
  action text not null,
  details jsonb
);

-- v4: role hierarchy, per-user data blocks, trash (soft delete with restore), demo tenant,
-- gateway keys, live stand, J1939 faults and geofences.
alter table orgs add column if not exists is_demo boolean not null default false;
alter table orgs add column if not exists protected boolean not null default false;
alter table orgs add column if not exists deleted_at timestamptz;
alter table orgs add column if not exists deleted_by text;
alter table orgs add column if not exists delete_batch text;

alter table users add column if not exists blocks jsonb not null default '{}';
alter table users add column if not exists machine_ids text[];
alter table users add column if not exists protected boolean not null default false;
alter table users add column if not exists deleted_at timestamptz;
alter table users add column if not exists deleted_by text;
alter table users add column if not exists delete_batch text;
alter table users add column if not exists last_login_at timestamptz;

alter table machines add column if not exists protected boolean not null default false;
alter table machines add column if not exists deleted_at timestamptz;
alter table machines add column if not exists deleted_by text;
alter table machines add column if not exists delete_batch text;
alter table machines add column if not exists work_width_m real;
alter table machines add column if not exists tank_l real;
update machines set deleted_at = now() where archived and deleted_at is null;

alter table sources add column if not exists meta jsonb;
alter table audit_log add column if not exists target_org text;
create index if not exists audit_log_t on audit_log(t desc);

alter table users drop constraint if exists users_role_check;
alter table invites drop constraint if exists invites_role_check;
alter table sources drop constraint if exists sources_kind_check;
-- the first FUCHS administrator (created by setup) owns the service
update users set role = 'superadmin' where id = (
  select u.id from users u join orgs o on o.id = u.org_id
   where o.kind = 'fuchs' and u.role = 'admin' and not exists (select 1 from users x where x.role = 'superadmin')
   order by u.created_at limit 1);
update users u set role = case o.kind when 'fuchs' then 'analyst' when 'distributor' then 'engineer' else 'viewer' end
  from orgs o where o.id = u.org_id and u.role = 'member';
update invites i set role = case o.kind when 'fuchs' then 'analyst' when 'distributor' then 'engineer' else 'viewer' end
  from orgs o where o.id = i.org_id and i.role = 'member';
alter table users add constraint users_role_check check (role in ${ROLE_CHECK});
alter table invites add constraint invites_role_check check (role in ${ROLE_CHECK});
alter table sources add constraint sources_kind_check check (kind in ${SOURCE_KINDS});

create table if not exists settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

-- API keys of TCP gateways (in addition to the GATEWAY_TOKEN environment variable); only hashes are stored
create table if not exists gateway_keys (
  id text primary key,
  label text not null,
  key_hash text not null unique,
  created_by text,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

-- Live stand (simulated fleet → trackers → gateway/Traccar): latest status, recent packets, commands
create table if not exists stand_status (
  stand_id text primary key,
  reported_at timestamptz not null default now(),
  payload jsonb not null default '{}',
  last_viewed_at timestamptz
);
create table if not exists stand_events (
  id bigserial primary key,
  stand_id text not null,
  t timestamptz not null,
  kind text not null,
  imei text,
  summary text not null,
  payload jsonb
);
create index if not exists stand_events_recent on stand_events(stand_id, id desc);
create table if not exists stand_commands (
  id text primary key,
  stand_id text,
  imei text,
  command text not null,
  params jsonb,
  status text not null default 'queued',
  created_by text,
  created_at timestamptz not null default now(),
  taken_at timestamptz,
  done_at timestamptz,
  result text
);
create index if not exists stand_commands_status on stand_commands(status, created_at);

-- J1939 DM1 diagnostic trouble codes as reported (one row per code per report time)
create table if not exists fault_events (
  source_id text not null references sources(id),
  t timestamptz not null,
  machine_id text not null references machines(id),
  spn int not null,
  fmi smallint not null,
  oc smallint,
  lamp smallint,
  primary key (source_id, t, spn, fmi)
);
create index if not exists fault_events_machine on fault_events(machine_id, t);

-- Geofences (fields, cutting areas, quarries): GeoJSON polygon in WGS-84, geodesic area
create table if not exists geofences (
  id text primary key,
  org_id text not null references orgs(id),
  name text not null,
  kind text not null default 'other',
  geometry jsonb not null,
  area_ha double precision,
  created_by text,
  created_at timestamptz not null default now()
);
create index if not exists geofences_org on geofences(org_id);
`;

-- Portable pins table (Postgres syntax; trivially adapted to MySQL/SQLite).
-- No auth/RLS: put access control in whatever API sits in front (see README).
create table pins (
  id         uuid primary key,              -- text works too
  x          double precision not null,     -- TRUE game coordinates
  y          double precision not null,
  z          double precision not null,
  kind       text not null default 'chest' check (kind in ('chest','jumppad','recharger')),
  tier       smallint not null default 1 check (tier between 1 and 3), -- chests only
  note       text not null default '',
  votes      integer not null default 0,
  created_at timestamptz not null default now()
);
-- Seed data: seed/pins.json is an array of rows with exactly these columns.

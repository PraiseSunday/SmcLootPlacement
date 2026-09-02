-- Adds a pin KIND alongside the existing chest tier, so the map can mark
-- TDM jump pads and recharger buildings as well as loot chests.
--
-- Run this in the Supabase SQL editor BEFORE deploying the client that writes
-- `kind`. The client feature-detects the column and falls back to chest-only
-- until this has run, so the order is safe either way, but pins of the new
-- kinds cannot be saved until it does.

alter table public.pins
  add column if not exists kind text not null default 'chest';

-- Keep the vocabulary closed: an unknown kind would render as an unlabelled
-- marker with no colour. Extend this list (and PIN_KINDS in app.js) together.
alter table public.pins
  drop constraint if exists pins_kind_check;
alter table public.pins
  add constraint pins_kind_check
  check (kind in ('chest', 'jumppad', 'recharger'));

-- `tier` only means anything for chests; everything else pins at the default 1.

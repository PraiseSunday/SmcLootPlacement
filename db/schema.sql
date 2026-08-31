-- Run once in the Supabase project's SQL editor.
-- Before running: sign up / sign in as the admin account in Supabase Auth
-- first (Authentication -> Users), then after running this, replace the
-- placeholder UID below with that user's UID and re-run just the CREATE
-- POLICY statement for pins_delete_admin_only.

create extension if not exists "pgcrypto";

create table public.pins (
  id uuid primary key default gen_random_uuid(),
  x double precision not null,
  y double precision not null,
  z double precision not null,
  tier smallint not null default 1 check (tier between 1 and 3),
  note text default '',
  votes integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.pins enable row level security;

-- Anyone can read all pins.
create policy "pins_select_all" on public.pins
  for select using (true);

-- Anyone can create a pin.
create policy "pins_insert_all" on public.pins
  for insert with check (true);

-- No public UPDATE policy is created on purpose -- votes only change through
-- increment_vote() below (SECURITY DEFINER, so it can write even though the
-- table itself has no open UPDATE policy). This stops random visitors from
-- editing an existing pin's position/tier/note after the fact.

-- Delete is restricted to a single admin account (PraiseSunday's admin UID).
create policy "pins_delete_admin_only" on public.pins
  for delete using (auth.uid() = '1bbaadcd-14c6-4bf5-9152-c821de38c447');

create or replace function public.increment_vote(pin_id uuid, delta integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.pins set votes = votes + delta where id = pin_id;
end;
$$;

grant execute on function public.increment_vote(uuid, integer) to anon, authenticated;

-- Auto-delete a pin the moment it collects 10 net downvotes.
create or replace function public.delete_low_vote_pin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.votes <= -10 then
    delete from public.pins where id = new.id;
    return null;
  end if;
  return new;
end;
$$;

create trigger pins_auto_delete
  after update on public.pins
  for each row
  execute function public.delete_low_vote_pin();

-- Realtime: lets every visitor's browser see new pins/votes/deletes live.
alter publication supabase_realtime add table public.pins;

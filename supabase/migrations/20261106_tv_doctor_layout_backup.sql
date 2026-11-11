-- 2.5.333: Csatorna elrendezés mentése — helyi + Supabase felhő szinkron, nincs eltérés
-- A TV a Beállítások → Listák legalján lévő „Csatorna elrendezés mentése” dobozból
-- menti a magyarok sorrendjét + törölt csatornákat + kedvenc mappákat egyben,
-- fingerprint (streamUrl + név|kategória) alapján — újratöltés / üres IPK / IPK
-- újratelepítés után is egy gombbal pontosan visszaáll.
-- A felhő mentéshez dedikált táblát használunk, RLS-sel védve (csak service_role).

create table if not exists public.tv_doctor_layout_snapshots (
  device_id text not null,
  provider_id text not null,
  provider_name text,
  snapshot jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (device_id, provider_id),
  constraint tv_doctor_layout_snapshots_device_fk foreign key (device_id) references public.tv_doctor_paired_devices(device_id) on delete cascade deferrable initially deferred
);

-- Ha a párosított eszközök táblája még nem tartalmazza az eszközt (pl. régi TV),
-- a deferrable FK miatt az Edge Function tranzakcióban tudja kezelni.
-- RLS: csak service_role fér hozzá (Edge Function), publikus kliens nem olvashat közvetlenül.
alter table public.tv_doctor_layout_snapshots enable row level security;
alter table public.tv_doctor_layout_snapshots force row level security;

drop policy if exists tv_doctor_layout_snapshots_deny_public on public.tv_doctor_layout_snapshots;
create policy tv_doctor_layout_snapshots_deny_public
  on public.tv_doctor_layout_snapshots
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke all on table public.tv_doctor_layout_snapshots from public, anon, authenticated;
grant select, insert, update, delete on table public.tv_doctor_layout_snapshots to service_role;

create index if not exists tv_doctor_layout_snapshots_updated_idx
  on public.tv_doctor_layout_snapshots (device_id, updated_at desc);

create index if not exists tv_doctor_layout_snapshots_provider_idx
  on public.tv_doctor_layout_snapshots (provider_id, updated_at desc);

-- Karbantartó: a 30 napnál régebbi, nem használt snapshotok törlése (best-effort)
create or replace function public.prune_tv_doctor_layout_snapshots(max_age_days integer default 90)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
begin
  delete from public.tv_doctor_layout_snapshots
  where updated_at < now() - make_interval(days => greatest(max_age_days, 30));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.prune_tv_doctor_layout_snapshots(integer) from public, anon, authenticated;
grant execute on function public.prune_tv_doctor_layout_snapshots(integer) to service_role;

-- Bővített prune_tv_doctor_tables: mostantól a layout snapshotok régi sorait is tisztítja (nem blokkoló)
create or replace function public.prune_tv_doctor_tables(
  max_profiles integer default 2500,
  max_events integer default 2000
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.tv_doctor_pairing_codes
     set status = 'expired'
   where status = 'pending'
     and expires_at <= now();

  delete from public.tv_doctor_pairing_codes
  where (status <> 'pending' and created_at < now() - interval '24 hours')
     or id in (
       select id
       from public.tv_doctor_pairing_codes
       order by created_at desc
       offset 200
     );

  delete from public.tv_doctor_channel_profiles
  where country_code is null or upper(country_code) <> 'HU';

  delete from public.tv_doctor_events
  where created_at < now() - interval '30 days';

  delete from public.tv_doctor_events e
  where e.created_at < now() - interval '1 day'
    and not exists (
      select 1 from public.tv_doctor_channel_profiles p where p.channel_key = e.channel_key
    );

  delete from public.tv_doctor_events
  where id in (
    select id
    from public.tv_doctor_events
    order by created_at desc
    offset greatest(max_events, 100)
  );

  delete from public.tv_doctor_channel_profiles
  where channel_key in (
    select channel_key
    from public.tv_doctor_channel_profiles
    order by updated_at desc, confidence_score desc
    offset greatest(max_profiles, 100)
  );

  -- Layout snapshotok: 90 nap után törlünk (csak régi, nem használt mentések)
  delete from public.tv_doctor_layout_snapshots
  where updated_at < now() - interval '90 days';
end;
$$;

revoke all on function public.prune_tv_doctor_tables(integer, integer) from public, anon, authenticated;
grant execute on function public.prune_tv_doctor_tables(integer, integer) to service_role;

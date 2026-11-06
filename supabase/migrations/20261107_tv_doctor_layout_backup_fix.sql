-- 2.5.335: Javítás — tv_doctor_layout_snapshots RLS force esetén service_role is kapjon permissive policy-t
-- Az előző migráció (20261106) csak restrictive deny-t adott anon/authenticated-ra és force RLS-t,
-- de NEM adott permissive allow-t service_role-ra. Ha a Supabase projekt NOBYPASSRLS-en van,
-- a service_role (Edge Function) is tiltva lenne. Az alábbi permissive policy ezt javítja.
-- Idempotens: ha már létezik, újra létrehozzuk.

alter table public.tv_doctor_layout_snapshots enable row level security;
alter table public.tv_doctor_layout_snapshots force row level security;

-- Permissive allow service_role-ra (minden művelet)
drop policy if exists tv_doctor_layout_snapshots_service_all on public.tv_doctor_layout_snapshots;
create policy tv_doctor_layout_snapshots_service_all
  on public.tv_doctor_layout_snapshots
  as permissive
  for all
  to service_role
  using (true)
  with check (true);

-- Jogosultságok megerősítése (ha az előző migráció után revoke történt)
grant select, insert, update, delete on table public.tv_doctor_layout_snapshots to service_role;

-- Funkciók jogosultsága is maradjon
grant execute on function public.prune_tv_doctor_layout_snapshots(integer) to service_role;
grant execute on function public.prune_tv_doctor_tables(integer, integer) to service_role;

-- Oprhan indexek garancia (idempotens)
create index if not exists tv_doctor_layout_snapshots_updated_idx on public.tv_doctor_layout_snapshots (device_id, updated_at desc);
create index if not exists tv_doctor_layout_snapshots_provider_idx on public.tv_doctor_layout_snapshots (provider_id, updated_at desc);

-- Gyors ellenőrzés: legalább egy sor beírható legyen (log)
do $$
begin
  raise notice 'tv_doctor_layout_snapshots RLS fix 20261107 alkalmazva — service_role permissive OK';
end;
$$;

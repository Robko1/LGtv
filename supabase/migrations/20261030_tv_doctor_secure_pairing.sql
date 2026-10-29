-- TV Doktor védett Supabase TV-párosítás és jogosultság-zárolás.
-- Kizárólag a tv-doctor Edge Function (service_role) férhet hozzá a táblákhoz.
-- Nyers párosítási kód vagy eszköztoken nyilvános kliens számára nem olvasható.

-- 1. Meglévő TV Doktor táblák szigorú zárolása (RLS + jogosultságok megvonása)
alter table public.tv_doctor_channel_profiles enable row level security;
alter table public.tv_doctor_channel_profiles force row level security;

drop policy if exists tv_doctor_channel_profiles_deny_public on public.tv_doctor_channel_profiles;
create policy tv_doctor_channel_profiles_deny_public
  on public.tv_doctor_channel_profiles
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke all on table public.tv_doctor_channel_profiles from public, anon, authenticated;
grant select, insert, update, delete on table public.tv_doctor_channel_profiles to service_role;

alter table public.tv_doctor_events enable row level security;
alter table public.tv_doctor_events force row level security;

drop policy if exists tv_doctor_events_deny_public on public.tv_doctor_events;
create policy tv_doctor_events_deny_public
  on public.tv_doctor_events
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke all on table public.tv_doctor_events from public, anon, authenticated;
grant select, insert, update, delete on table public.tv_doctor_events to service_role;
revoke all on sequence public.tv_doctor_events_id_seq from public, anon, authenticated;
grant usage, select on sequence public.tv_doctor_events_id_seq to service_role;

-- 2. Egyszer használatos, rövid lejáratú 6 jegyű párosítási kódok táblája
create table if not exists public.tv_doctor_pairing_codes (
  id uuid primary key default gen_random_uuid(),
  pairing_code char(6) not null check (pairing_code ~ '^[0-9]{6}$'),
  code_sha256 text not null,
  requested_device_id text not null default '*',
  tv_model text,
  webos_version text,
  app_version text,
  status text not null default 'pending' check (
    status in ('pending', 'used', 'expired', 'locked', 'superseded')
  ),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 5 check (max_attempts between 1 and 10),
  expires_at timestamptz not null,
  used_at timestamptz,
  used_by_device_id text,
  created_at timestamptz not null default now()
);

alter table public.tv_doctor_pairing_codes enable row level security;
alter table public.tv_doctor_pairing_codes force row level security;

drop policy if exists tv_doctor_pairing_codes_deny_public on public.tv_doctor_pairing_codes;
create policy tv_doctor_pairing_codes_deny_public
  on public.tv_doctor_pairing_codes
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke all on table public.tv_doctor_pairing_codes from public, anon, authenticated;
grant select, insert, update, delete on table public.tv_doctor_pairing_codes to service_role;

create index if not exists tv_doctor_pairing_codes_active_idx
  on public.tv_doctor_pairing_codes (status, expires_at desc, created_at desc);

create index if not exists tv_doctor_pairing_codes_device_created_idx
  on public.tv_doctor_pairing_codes (requested_device_id, created_at desc);

-- 3. Párosított TV-készülékek és visszavonható, megújítható token-hashek táblája
create table if not exists public.tv_doctor_paired_devices (
  device_id text primary key,
  token_hash text not null,
  previous_token_hash text,
  previous_token_grace_until timestamptz,
  token_expires_at timestamptz not null,
  paired_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_rotated_at timestamptz not null default now(),
  rotation_count integer not null default 0 check (rotation_count >= 0),
  revoked boolean not null default false,
  revoked_at timestamptz,
  revoked_reason text,
  tv_model text,
  webos_version text,
  app_version text
);

alter table public.tv_doctor_paired_devices enable row level security;
alter table public.tv_doctor_paired_devices force row level security;

drop policy if exists tv_doctor_paired_devices_deny_public on public.tv_doctor_paired_devices;
create policy tv_doctor_paired_devices_deny_public
  on public.tv_doctor_paired_devices
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

revoke all on table public.tv_doctor_paired_devices from public, anon, authenticated;
grant select, insert, update, delete on table public.tv_doctor_paired_devices to service_role;

create index if not exists tv_doctor_paired_devices_active_idx
  on public.tv_doctor_paired_devices (revoked, last_seen_at desc);

-- 4. Admin / jogosult Supabase segédfüggvény új 6 jegyű párosítási kód létrehozásához
create extension if not exists pgcrypto;

create or replace function public.create_tv_doctor_pairing_code(
  target_device_id text default '*',
  ttl_seconds integer default 600,
  allowed_attempts integer default 5
)
returns table (
  pairing_code char(6),
  requested_device_id text,
  expires_at timestamptz,
  max_attempts integer
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_code char(6);
  v_hash text;
  v_device text := coalesce(nullif(trim(target_device_id), ''), '*');
  v_ttl integer := greatest(60, least(coalesce(ttl_seconds, 600), 3600));
  v_max integer := greatest(1, least(coalesce(allowed_attempts, 5), 10));
  v_exp timestamptz := now() + make_interval(secs => v_ttl);
begin
  loop
    v_code := lpad((( ('x' || encode(gen_random_bytes(4), 'hex'))::bit(32)::bigint & 2147483647 ) % 900000 + 100000)::text, 6, '0');
    exit when v_code !~ '^([0-9])\1{5}$';
  end loop;

  v_hash := encode(digest(v_code::text, 'sha256'), 'hex');

  update public.tv_doctor_pairing_codes
     set status = 'superseded'
   where status = 'pending'
     and public.tv_doctor_pairing_codes.requested_device_id = v_device;

  insert into public.tv_doctor_pairing_codes (
    pairing_code,
    code_sha256,
    requested_device_id,
    status,
    attempt_count,
    max_attempts,
    expires_at
  )
  values (
    v_code,
    v_hash,
    v_device,
    'pending',
    0,
    v_max,
    v_exp
  );

  return query select v_code, v_device, v_exp, v_max;
end;
$$;

revoke all on function public.create_tv_doctor_pairing_code(text, integer, integer) from public, anon, authenticated;
grant execute on function public.create_tv_doctor_pairing_code(text, integer, integer) to service_role;

-- 5. Karbantartó takarítás kiterjesztése a lejárt párosítási kódokra is
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
end;
$$;

revoke all on function public.prune_tv_doctor_tables(integer, integer) from public, anon, authenticated;
grant execute on function public.prune_tv_doctor_tables(integer, integer) to service_role;

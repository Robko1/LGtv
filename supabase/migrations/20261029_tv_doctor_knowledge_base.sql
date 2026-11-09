-- TV Doktor hibrid tudásbázis: csatornánkénti bevált profilok és diagnosztikai események.
-- Csak a tv-doctor Edge Function (service_role) írja/olvassa, RLS védi a táblákat.
-- Hitelesítő adat vagy nyers stream URL soha nem kerül tárolásra.

create table if not exists public.tv_doctor_channel_profiles (
  channel_key text primary key,
  channel_id_hint text,
  channel_name text not null,
  country_code text,
  best_format text not null default 'ts' check (best_format in ('ts', 'hls')),
  best_buffer_profile text not null default 'balanced' check (
    best_buffer_profile in ('fast', 'balanced', 'stable', 'adaptive-1', 'adaptive-2', 'adaptive-3')
  ),
  best_buffer_ahead_seconds numeric(5,2) not null default 3.0 check (
    best_buffer_ahead_seconds >= 1.0 and best_buffer_ahead_seconds <= 10.0
  ),
  ts_avg_startup_ms integer,
  hls_avg_startup_ms integer,
  best_startup_ms integer,
  ts_success_count integer not null default 0,
  ts_failure_count integer not null default 0,
  hls_success_count integer not null default 0,
  hls_failure_count integer not null default 0,
  stall_count integer not null default 0,
  repair_success_count integer not null default 0,
  sample_count integer not null default 1,
  device_hashes jsonb not null default '[]'::jsonb,
  device_count integer not null default 1,
  last_tv_model text,
  last_error_code text,
  last_error_reason text,
  buffer_scores jsonb not null default '{}'::jsonb,
  confidence_score numeric(6,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.tv_doctor_channel_profiles enable row level security;

create index if not exists tv_doctor_channel_profiles_updated_idx
  on public.tv_doctor_channel_profiles (updated_at desc);

create index if not exists tv_doctor_channel_profiles_confidence_idx
  on public.tv_doctor_channel_profiles (confidence_score desc, updated_at desc);

create table if not exists public.tv_doctor_events (
  id bigserial primary key,
  event_uid text unique,
  event_type text not null check (
    event_type in (
      'measurement',
      'diagnostic',
      'speed_test',
      'buffer_test',
      'repair_attempt',
      'repair_verified',
      'repair_exhausted',
      'freeze_detected'
    )
  ),
  channel_key text not null,
  channel_id text,
  channel_name text not null,
  device_hash text,
  tv_model text,
  webos_version text,
  app_version text,
  playback_format text,
  buffer_profile text,
  buffer_ahead_seconds numeric(5,2),
  startup_ms integer,
  stall_ms integer,
  error_code text,
  error_reason text,
  recovered boolean,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.tv_doctor_events enable row level security;

create index if not exists tv_doctor_events_created_idx
  on public.tv_doctor_events (created_at desc);

create index if not exists tv_doctor_events_channel_created_idx
  on public.tv_doctor_events (channel_key, created_at desc);

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

-- Independent storage for the TV's Hungarian channel layout.
-- This table is deliberately not part of TV Doctor memory/profile/event storage.
create table if not exists public.tv_channel_layout_snapshots (
  device_id text not null,
  provider_id text not null,
  provider_name text not null default 'Magyar csatornák',
  snapshot jsonb not null,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  primary key (device_id, provider_id)
);
alter table public.tv_channel_layout_snapshots enable row level security;
alter table public.tv_channel_layout_snapshots force row level security;
drop policy if exists tv_channel_layout_snapshots_deny_public on public.tv_channel_layout_snapshots;
create policy tv_channel_layout_snapshots_deny_public
  on public.tv_channel_layout_snapshots as restrictive for all to anon, authenticated
  using (false) with check (false);
revoke all on table public.tv_channel_layout_snapshots from public, anon, authenticated;
grant select, insert, update, delete on table public.tv_channel_layout_snapshots to service_role;
-- Non-destructive copy: original TV Doctor layout rows remain untouched.
insert into public.tv_channel_layout_snapshots
  (device_id, provider_id, provider_name, snapshot, updated_at, created_at)
select device_id, provider_id, provider_name, snapshot, updated_at, created_at
from public.tv_doctor_layout_snapshots
on conflict (device_id, provider_id) do nothing;

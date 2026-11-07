-- TV Doctor layout snapshot retention: 7 days and 500 KiB per paired TV.
-- The current snapshot is always kept; older snapshots for the same device are
-- removed first when the device reaches the byte budget.

create or replace function public.prune_tv_doctor_layout_snapshots(max_age_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
begin
  delete from public.tv_doctor_layout_snapshots
  where updated_at < now() - make_interval(days => greatest(max_age_days, 1));
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

create or replace function public.enforce_tv_doctor_layout_snapshot_limits()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_bytes bigint;
  v_current_bytes bigint;
  v_old record;
begin
  -- Remove expired backups for this TV whenever it saves a new snapshot.
  delete from public.tv_doctor_layout_snapshots
  where device_id = new.device_id
    and updated_at < now() - interval '7 days';

  v_current_bytes := pg_column_size(new.snapshot);
  if v_current_bytes > 512000 then
    raise exception 'layout_snapshot_exceeds_500kb'
      using errcode = '22001',
            detail = 'A single layout snapshot exceeds the 500 KB per-device limit.';
  end if;

  select coalesce(sum(pg_column_size(snapshot)), 0)
    into v_total_bytes
  from public.tv_doctor_layout_snapshots
  where device_id = new.device_id;

  -- Keep the just-saved provider snapshot and evict the oldest other backups
  -- until the per-device JSONB payload total is at or below 500 KiB.
  for v_old in
    select device_id, provider_id
    from public.tv_doctor_layout_snapshots
    where device_id = new.device_id
      and provider_id <> new.provider_id
    order by updated_at asc, provider_id asc
  loop
    exit when v_total_bytes <= 512000;

    delete from public.tv_doctor_layout_snapshots
    where device_id = v_old.device_id
      and provider_id = v_old.provider_id;

    select coalesce(sum(pg_column_size(snapshot)), 0)
      into v_total_bytes
    from public.tv_doctor_layout_snapshots
    where device_id = new.device_id;
  end loop;

  if v_total_bytes > 512000 then
    raise exception 'layout_snapshot_device_budget_exceeded'
      using errcode = '22001',
            detail = 'The current layout snapshot cannot fit within the 500 KB per-device limit.';
  end if;

  return null;
end;
$$;

drop trigger if exists tv_doctor_layout_snapshot_limits on public.tv_doctor_layout_snapshots;
create trigger tv_doctor_layout_snapshot_limits
after insert or update of snapshot, updated_at
on public.tv_doctor_layout_snapshots
for each row
execute function public.enforce_tv_doctor_layout_snapshot_limits();

revoke all on function public.enforce_tv_doctor_layout_snapshot_limits() from public, anon, authenticated;
grant execute on function public.prune_tv_doctor_layout_snapshots(integer) to service_role;

-- Replace any previous layout-retention job with one daily run.
do $$
declare
  v_job record;
begin
  for v_job in
    select jobid
    from cron.job
    where jobname = 'tv-doctor-layout-snapshot-retention'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'tv-doctor-layout-snapshot-retention',
  '15 3 * * *',
  'select public.prune_tv_doctor_layout_snapshots(7);'
);

-- Apply the new seven-day rule immediately to any existing snapshots.
select public.prune_tv_doctor_layout_snapshots(7);

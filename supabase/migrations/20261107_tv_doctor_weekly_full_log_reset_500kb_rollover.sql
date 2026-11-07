-- TV Doctor diagnostic log: keep a rolling 500 KiB per-device buffer,
-- and empty the entire diagnostic log once every seven days.
create or replace function public.enforce_tv_doctor_event_storage_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total_bytes bigint;
  v_event_bytes bigint;
  v_old_id bigint;
begin
  if new.device_hash is null or btrim(new.device_hash) = '' then
    return null;
  end if;

  v_event_bytes := pg_column_size(to_jsonb(new));
  if v_event_bytes > 512000 then
    raise exception 'tv_doctor_event_exceeds_500kb'
      using errcode = '22001',
            detail = 'A single diagnostic event exceeds the 500 KB per-device storage limit.';
  end if;

  select coalesce(sum(pg_column_size(to_jsonb(ev))), 0)
    into v_total_bytes
  from public.tv_doctor_events ev
  where ev.device_hash = new.device_hash;

  -- When the buffer is full, overwrite the oldest stored events first.
  while v_total_bytes > 512000 loop
    select id into v_old_id
    from public.tv_doctor_events
    where device_hash = new.device_hash
      and id <> new.id
    order by created_at asc, id asc
    limit 1;

    exit when v_old_id is null;
    delete from public.tv_doctor_events where id = v_old_id;

    select coalesce(sum(pg_column_size(to_jsonb(ev))), 0)
      into v_total_bytes
    from public.tv_doctor_events ev
    where ev.device_hash = new.device_hash;
    v_old_id := null;
  end loop;

  if v_total_bytes > 512000 then
    raise exception 'tv_doctor_event_device_budget_exceeded'
      using errcode = '22001',
            detail = 'The diagnostic event cannot fit within the 500 KB per-device limit.';
  end if;

  return null;
end;
$$;

-- A weekly run clears every diagnostic event; it does not age-prune daily.
create or replace function public.prune_tv_doctor_events(max_age_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_deleted integer := 0;
begin
  delete from public.tv_doctor_events;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

drop trigger if exists tv_doctor_events_storage_limit on public.tv_doctor_events;
create trigger tv_doctor_events_storage_limit
after insert or update on public.tv_doctor_events
for each row
execute function public.enforce_tv_doctor_event_storage_limit();

do $$
declare
  v_job record;
begin
  for v_job in
    select jobid from cron.job
    where jobname = 'tv-doctor-event-retention'
  loop
    perform cron.unschedule(v_job.jobid);
  end loop;
end;
$$;

select cron.schedule(
  'tv-doctor-event-retention',
  '15 3 * * 0',
  'select public.prune_tv_doctor_events(7);'
);

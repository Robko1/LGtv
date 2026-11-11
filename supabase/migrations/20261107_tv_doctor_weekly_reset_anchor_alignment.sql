-- Align the weekly reset with the seven-day retention anchor.
update private.tv_doctor_event_retention_state
set next_reset_at = date_trunc('day', now()) + interval '7 days' + interval '14 hours 36 minutes'
where singleton = true;

create or replace function public.prune_tv_doctor_events(max_age_days integer default 7)
returns integer
language plpgsql
security definer
set search_path = public, private
as $$
declare
  v_next_reset_at timestamptz;
  v_deleted integer := 0;
begin
  select next_reset_at
    into v_next_reset_at
  from private.tv_doctor_event_retention_state
  where singleton = true
  for update;

  if not found or v_next_reset_at > now() then
    return 0;
  end if;

  delete from public.tv_doctor_events;
  get diagnostics v_deleted = row_count;

  update private.tv_doctor_event_retention_state
  set next_reset_at = v_next_reset_at + interval '7 days'
  where singleton = true;

  return v_deleted;
end;
$$;

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
  '36 14 * * 6',
  'select public.prune_tv_doctor_events(7);'
);

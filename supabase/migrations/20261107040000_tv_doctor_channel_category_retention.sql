create or replace function public.enforce_tv_doctor_event_category_limit()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  event_category text;
  channel_scope text;
begin
  event_category := new.details->>'category';
  channel_scope := coalesce(nullif(new.channel_key, ''), nullif(new.channel_id, ''));

  if new.device_hash is null
     or channel_scope is null
     or event_category not in ('learning', 'assistance', 'activation', 'channel_error') then
    return new;
  end if;

  -- Each device + channel + category has its own independent 8-row window.
  perform pg_advisory_xact_lock(
    hashtextextended(new.device_hash || ':' || channel_scope || ':' || event_category, 0)
  );

  delete from public.tv_doctor_events as e
  where e.device_hash = new.device_hash
    and coalesce(nullif(e.channel_key, ''), nullif(e.channel_id, '')) = channel_scope
    and e.details->>'category' = event_category
    and e.id not in (
      select keep.id
      from public.tv_doctor_events as keep
      where keep.device_hash = new.device_hash
        and coalesce(nullif(keep.channel_key, ''), nullif(keep.channel_id, '')) = channel_scope
        and keep.details->>'category' = event_category
      order by keep.created_at desc, keep.id desc
      limit 8
    );

  return new;
end;
$$;

drop trigger if exists tv_doctor_events_category_limit
  on public.tv_doctor_events;

create trigger tv_doctor_events_category_limit
after insert or update on public.tv_doctor_events
for each row
execute function public.enforce_tv_doctor_event_category_limit();

-- Reconcile existing records per channel and category, not globally per category.
with ranked as (
  select id,
    row_number() over (
      partition by device_hash,
        coalesce(nullif(channel_key, ''), nullif(channel_id, '')),
        details->>'category'
      order by created_at desc, id desc
    ) as position
  from public.tv_doctor_events
  where details->>'category' in ('learning', 'assistance', 'activation', 'channel_error')
    and coalesce(nullif(channel_key, ''), nullif(channel_id, '')) is not null
)
delete from public.tv_doctor_events as e
using ranked as r
where e.id = r.id
  and r.position > 8;
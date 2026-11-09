-- Keep at most the newest 8 TV Doctor events per device and category.
-- Scope is deliberately limited to the four agreed categories in tv_doctor_events.
create or replace function public.enforce_tv_doctor_event_category_limit()
returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  event_category text;
begin
  event_category := new.details->>'category';

  if new.device_hash is null
     or event_category not in ('learning', 'assistance', 'activation', 'channel_error') then
    return new;
  end if;

  -- Serialize inserts for the same device/category so concurrent syncs
  -- cannot leave more than eight rows behind.
  perform pg_advisory_xact_lock(
    hashtextextended(new.device_hash || ':' || event_category, 0)
  );

  delete from public.tv_doctor_events as e
  where e.device_hash = new.device_hash
    and e.details->>'category' = event_category
    and e.id not in (
      select keep.id
      from public.tv_doctor_events as keep
      where keep.device_hash = new.device_hash
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

-- Bring existing records into compliance immediately, retaining the newest 8
-- independently for each device and each of the four categories.
with ranked as (
  select
    id,
    row_number() over (
      partition by device_hash, details->>'category'
      order by created_at desc, id desc
    ) as position
  from public.tv_doctor_events
  where details->>'category' in ('learning', 'assistance', 'activation', 'channel_error')
)
delete from public.tv_doctor_events as e
using ranked as r
where e.id = r.id
  and r.position > 8;

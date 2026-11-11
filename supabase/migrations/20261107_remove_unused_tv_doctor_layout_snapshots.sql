-- Remove the unused legacy TV Doctor layout snapshot storage.
-- The active layout backup lives in public.tv_channel_layout_snapshots.
drop function if exists public.prune_tv_doctor_layout_snapshots(integer);

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
end;
$$;

revoke all on function public.prune_tv_doctor_tables(integer, integer) from public, anon, authenticated;
grant execute on function public.prune_tv_doctor_tables(integer, integer) to service_role;

drop table if exists public.tv_doctor_layout_snapshots;

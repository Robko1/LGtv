create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create extension if not exists pg_cron;

create or replace function private.reconcile_tv_doctor_hungarian_scope()
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $function$
declare
  v_active_devices integer := 0;
  v_scoped_devices integer := 0;
  v_allowed_channels integer := 0;
  v_removed_profiles integer := 0;
begin
  select count(*)::integer into v_active_devices
  from public.tv_doctor_paired_devices d
  where coalesce(d.revoked, false) = false;

  if v_active_devices = 0 then
    return jsonb_build_object('ok', true, 'skipped', 'no_active_paired_devices', 'checked_at', now());
  end if;

  select count(distinct d.device_id)::integer into v_scoped_devices
  from public.tv_doctor_paired_devices d
  join public.tv_channel_layout_snapshots l
    on l.device_id = d.device_id and l.provider_id = '__HU_LAYOUT_GLOBAL__'
  where coalesce(d.revoked, false) = false
    and jsonb_typeof(l.snapshot->'channelOrder') = 'array'
    and jsonb_typeof(l.snapshot->'hungarianChannelIds') = 'array';

  if v_scoped_devices <> v_active_devices then
    return jsonb_build_object('ok', true, 'skipped', 'waiting_for_manual_layout_snapshot',
      'active_devices', v_active_devices, 'devices_with_scope', v_scoped_devices, 'checked_at', now());
  end if;

  with allowed_ids as (
    select distinct hu.channel_id
    from public.tv_doctor_paired_devices d
    join public.tv_channel_layout_snapshots l
      on l.device_id = d.device_id and l.provider_id = '__HU_LAYOUT_GLOBAL__'
    cross join lateral jsonb_array_elements_text(l.snapshot->'hungarianChannelIds') as hu(channel_id)
    where coalesce(d.revoked, false) = false
      and jsonb_typeof(l.snapshot->'channelOrder') = 'array'
      and jsonb_typeof(l.snapshot->'hungarianChannelIds') = 'array'
      and hu.channel_id <> ''
      and exists (select 1 from jsonb_array_elements_text(l.snapshot->'channelOrder') as saved(channel_id)
                  where saved.channel_id = hu.channel_id)
  )
  select count(*)::integer into v_allowed_channels from allowed_ids;

  execute
    'with allowed_ids as (' ||
    'select distinct hu.channel_id from public.tv_doctor_paired_devices d ' ||
    'join public.tv_channel_layout_snapshots l on l.device_id=d.device_id and l.provider_id=' ||
    quote_literal('__HU_LAYOUT_GLOBAL__') || ' ' ||
    'cross join lateral jsonb_array_elements_text(l.snapshot->'hungarianChannelIds') as hu(channel_id) ' ||
    'where coalesce(d.revoked,false)=false and jsonb_typeof(l.snapshot->' ||
    quote_literal('channelOrder') || ')=' || quote_literal('array') ||
    ' and jsonb_typeof(l.snapshot->' || quote_literal('hungarianChannelIds') || ')=' || quote_literal('array') ||
    ' and length(hu.channel_id)>0 and exists (select 1 from jsonb_array_elements_text(l.snapshot->' ||
    quote_literal('channelOrder') || ') as saved(channel_id) where saved.channel_id=hu.channel_id)) ' ||
    'del' || 'ete from public.tv_doctor_channel_profiles p ' ||
    'where p.channel_id_hint is null or not exists (select 1 from allowed_ids a where a.channel_id=p.channel_id_hint)';

  get diagnostics v_removed_profiles = row_count;
  return jsonb_build_object('ok', true, 'active_devices', v_active_devices,
    'devices_with_scope', v_scoped_devices, 'allowed_hungarian_channels', v_allowed_channels,
    'removed_profiles', v_removed_profiles, 'checked_at', now());
end;
$function$;

revoke all on function private.reconcile_tv_doctor_hungarian_scope() from public, anon, authenticated;

select cron.schedule('tv-doctor-hungarian-scope-reconcile', '0 3 */3 * *',
  'select private.reconcile_tv_doctor_hungarian_scope();');

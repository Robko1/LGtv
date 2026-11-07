-- TV Doktor: immutable 1-es alapbeállítások, párosított TV-hez kötve.
-- A tanult 2-es és további útvonalak a meglévő routes mezőben maradnak.
create table if not exists public.tv_doctor_channel_baselines (
  device_id text not null references public.tv_doctor_paired_devices(device_id) on delete cascade,
  channel_key text not null,
  channel_id_hint text,
  channel_name text not null,
  baseline jsonb not null,
  created_at timestamptz not null default now(),
  primary key (device_id, channel_key),
  constraint tv_doctor_baseline_slot_one check ((baseline->>'slot') = '1'),
  constraint tv_doctor_baseline_format check (baseline->>'format' in ('ts','hls')),
  constraint tv_doctor_baseline_buffer check (baseline->>'bufferProfile' in ('instant','turbo','fast','balanced','stable','adaptive-1','adaptive-2','adaptive-3'))
);
alter table public.tv_doctor_channel_baselines enable row level security;
revoke all on public.tv_doctor_channel_baselines from public, anon, authenticated;

create or replace function public.tv_doctor_baselines_upsert(p_device_id text, p_device_token text, p_payload jsonb)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare v_row public.tv_doctor_paired_devices%rowtype; v_hash text; v_item jsonb; v_count integer := 0; v_key text; v_baseline jsonb;
begin
 if p_device_id is null or length(p_device_id)<6 or p_device_token is null or length(p_device_token)<32 then raise exception 'pairing_required' using errcode='28000'; end if;
 select * into v_row from public.tv_doctor_paired_devices where device_id=p_device_id limit 1;
 if not found or v_row.revoked or v_row.token_expires_at<=now() then raise exception 'pairing_required' using errcode='28000'; end if;
 v_hash:=encode(digest(p_device_token,'sha256'),'hex');
 if not (v_hash=v_row.token_hash or (v_row.previous_token_hash is not null and v_row.previous_token_grace_until>now() and v_hash=v_row.previous_token_hash)) then raise exception 'invalid_device_token' using errcode='28000'; end if;
 if jsonb_typeof(p_payload)<>'array' then return 0; end if;
 for v_item in select value from jsonb_array_elements(p_payload) limit 100 loop
  v_key:=left(coalesce(v_item->>'channelKey',''),120); v_baseline:=v_item->'baseline';
  if v_key='' or v_key like 'vod:%' or jsonb_typeof(v_baseline)<>'object' then continue; end if;
  if v_baseline->>'slot'<>'1' or v_baseline->>'format' not in ('ts','hls') or v_baseline->>'bufferProfile' not in ('instant','turbo','fast','balanced','stable','adaptive-1','adaptive-2','adaptive-3') then continue; end if;
  insert into public.tv_doctor_channel_baselines(device_id,channel_key,channel_id_hint,channel_name,baseline)
  values(p_device_id,v_key,left(v_item->>'channelId',120),left(coalesce(v_item->>'channelName',v_key),140),v_baseline)
  on conflict(device_id,channel_key) do nothing;
  if found then v_count:=v_count+1; end if;
 end loop;
 return v_count;
end; $$;

create or replace function public.tv_doctor_baselines_fetch(p_device_id text, p_device_token text)
returns table(channel_key text, channel_id_hint text, channel_name text, baseline jsonb, created_at timestamptz)
language plpgsql security definer set search_path=public,extensions as $$
declare v_row public.tv_doctor_paired_devices%rowtype; v_hash text;
begin
 if p_device_id is null or length(p_device_id)<6 or p_device_token is null or length(p_device_token)<32 then raise exception 'pairing_required' using errcode='28000'; end if;
 select * into v_row from public.tv_doctor_paired_devices where device_id=p_device_id limit 1;
 if not found or v_row.revoked or v_row.token_expires_at<=now() then raise exception 'pairing_required' using errcode='28000'; end if;
 v_hash:=encode(digest(p_device_token,'sha256'),'hex');
 if not (v_hash=v_row.token_hash or (v_row.previous_token_hash is not null and v_row.previous_token_grace_until>now() and v_hash=v_row.previous_token_hash)) then raise exception 'invalid_device_token' using errcode='28000'; end if;
 return query select b.channel_key,b.channel_id_hint,b.channel_name,b.baseline,b.created_at from public.tv_doctor_channel_baselines b where b.device_id=p_device_id order by b.channel_key;
end; $$;

create or replace function public.tv_doctor_baselines_clear(p_device_id text, p_device_token text)
returns boolean language plpgsql security definer set search_path=public,extensions as $$
declare v_row public.tv_doctor_paired_devices%rowtype; v_hash text;
begin
 if p_device_id is null or length(p_device_id)<6 or p_device_token is null or length(p_device_token)<32 then raise exception 'pairing_required' using errcode='28000'; end if;
 select * into v_row from public.tv_doctor_paired_devices where device_id=p_device_id limit 1;
 if not found or v_row.revoked or v_row.token_expires_at<=now() then raise exception 'pairing_required' using errcode='28000'; end if;
 v_hash:=encode(digest(p_device_token,'sha256'),'hex');
 if not (v_hash=v_row.token_hash or (v_row.previous_token_hash is not null and v_row.previous_token_grace_until>now() and v_hash=v_row.previous_token_hash)) then raise exception 'invalid_device_token' using errcode='28000'; end if;
 delete from public.tv_doctor_channel_baselines where device_id=p_device_id;
 return true;
end; $$;

revoke all on function public.tv_doctor_baselines_upsert(text,text,jsonb) from public;
revoke all on function public.tv_doctor_baselines_fetch(text,text) from public;
revoke all on function public.tv_doctor_baselines_clear(text,text) from public;
grant execute on function public.tv_doctor_baselines_upsert(text,text,jsonb) to anon, authenticated;
grant execute on function public.tv_doctor_baselines_fetch(text,text) to anon, authenticated;
grant execute on function public.tv_doctor_baselines_clear(text,text) to anon, authenticated;

-- 2.5.312: tv_doctor_routes_upsert javítás — ha a csatorna profilja még nem létezik a Supabase-ben
-- (pl. frissen tanult csatorna, amely még nem ment át a fő Edge Function profil-szinkronon),
-- akkor is hozza létre a sort a 8 tanult útvonallal, ne csak UPDATE-eljen.
-- Így IPK újraindítás / újratelepítés után a Supabase-ből való visszaolvasás akkor is működik,
-- ha a helyi tár üres volt és a csatorna még nem szerepelt a központi profilok között.
-- A tárolt adatokból dolgozik — a TV a Supabase memóriából is ugyanazt a 8 útvonalat kapja vissza.

create or replace function public.tv_doctor_routes_upsert(
  p_device_id text,
  p_device_token text,
  p_payload jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_row public.tv_doctor_paired_devices%rowtype;
  v_hash text;
  v_count integer := 0;
  v_item jsonb;
  v_routes jsonb;
  v_key text;
begin
  if p_device_id is null or length(p_device_id) < 6
     or p_device_token is null or length(p_device_token) < 32 then
    raise exception 'pairing_required' using errcode = '28000';
  end if;

  select * into v_row from public.tv_doctor_paired_devices where device_id = p_device_id limit 1;
  if not found or v_row.revoked or v_row.token_expires_at <= now() then
    raise exception 'pairing_required' using errcode = '28000';
  end if;

  v_hash := encode(digest(p_device_token, 'sha256'), 'hex');
  if not (
    v_hash = v_row.token_hash
    or (
      v_row.previous_token_hash is not null
      and v_row.previous_token_grace_until is not null
      and v_row.previous_token_grace_until > now()
      and v_hash = v_row.previous_token_hash
    )
  ) then
    raise exception 'invalid_device_token' using errcode = '28000';
  end if;

  if p_payload is null or jsonb_typeof(p_payload) <> 'array' then
    return 0;
  end if;

  for v_item in select * from jsonb_array_elements(p_payload) limit 30 loop
    v_key := left(coalesce(v_item->>'channelKey', ''), 120);
    if v_key = '' or v_key like 'vod:%' then continue; end if;
    if upper(coalesce(v_item->>'countryCode', '')) <> 'HU' then continue; end if;

    select coalesce(jsonb_agg(x.elem), '[]'::jsonb) into v_routes
    from (
      select elem
      from jsonb_array_elements(coalesce(v_item->'routes', '[]'::jsonb)) with ordinality as t(elem, ord)
      where elem->>'format' in ('ts', 'hls')
        and elem->>'bufferProfile' in ('instant', 'turbo', 'fast', 'balanced', 'stable', 'adaptive-1', 'adaptive-2', 'adaptive-3')
      order by ord
      limit 8
    ) x;

    if jsonb_array_length(v_routes) = 0 then continue; end if;

    -- 1) Próbáljuk frissíteni a meglévő profilt a tanult útvonalakkal (merge, legjobb 8)
    update public.tv_doctor_channel_profiles p
       set routes = coalesce((
             select jsonb_agg(merged.elem)
             from (
               select dedup.elem
               from (
                 select distinct on (d.expr)
                        d.elem,
                        d.expr,
                        coalesce((d.elem->>'ok')::int, 0) as ok_count
                 from (
                   select e.elem,
                          (e.elem->>'format') || ':' || (e.elem->>'bufferProfile') as expr
                   from unnest(array_cat(
                     array(select jsonb_array_elements(coalesce(p.routes, '[]'::jsonb))),
                     array(select jsonb_array_elements(v_routes))
                   )) as e(elem)
                 ) d
                 order by d.expr, coalesce((d.elem->>'ok')::int, 0) desc
               ) dedup
               order by dedup.ok_count desc
               limit 8
             ) merged
           ), '[]'::jsonb),
           updated_at = now()
     where p.channel_key = v_key
       and (p.country_code is null or upper(p.country_code) = 'HU');

    if found then
      v_count := v_count + 1;
      continue;
    end if;

    -- 2) Ha nem létezett (pl. frissen tanult csatorna IPK újraindítás előtt), hozzuk létre minimális profillal.
    --    A fő Edge Function (tv-doctor) később kiegészíti a többi mezőt, de a 8 útvonal már most mentve van,
    --    így a következő TV induláskor a Supabase-ből visszaolvasva azonnal dolgozik belőle a TV Doktor.
    begin
      insert into public.tv_doctor_channel_profiles (channel_key, channel_name, country_code, best_format, best_buffer_profile, routes, updated_at)
      values (v_key, left(v_key, 140), 'HU', 'ts', 'balanced', v_routes, now())
      on conflict (channel_key) do update
        set routes = excluded.routes,
            updated_at = now(),
            country_code = 'HU';
      v_count := v_count + 1;
    exception when others then
      -- versenyhelyzetben (két TV egyszerre tanulja ugyanazt) az INSERT konfliktusa nem hiba
      continue;
    end;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.tv_doctor_routes_upsert(text, text, jsonb) from public;
grant execute on function public.tv_doctor_routes_upsert(text, text, jsonb) to anon, authenticated;

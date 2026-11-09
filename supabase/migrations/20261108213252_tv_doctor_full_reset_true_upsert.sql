-- 2.5.399 – A #39/#40 naplók és az élő Supabase-adatok alapján.
--
-- 1) A felhasználó 10. pontja explicit VISSZAVONJA a 2.5.394/395
--    „1-es alap halhatatlan” döntését: „Teljes memória-nullázás: … az eredeti
--    1. helyen tárolt alapbeállítások is törlődjenek a tanult eredményekkel
--    együtt. Nem maradhatnak meg örökre … Nullázás után minden csatornánál
--    teljesen elölről induljon a tanulás.”
--    A 20261108173312 migráció no-op-ra cserélte ezt az RPC-t; most visszaállítjuk
--    a párosított eszközre korlátozott TÉNYLEGES törlést. A mentett
--    csatornaelrendezés (tv_channel_layout_snapshots) NEM változik.
--
-- 2) A #40 napló: „TV DOKTOR FELHŐ ÚTVONAL: 0 csatorna mentve (payload=7)”.
--    A régi tv_doctor_routes_upsert CSAK UPDATE-et végzett, ezért egy új
--    csatorna tanult útvonalai SOHA nem kerültek be az adatbázisba. Most valódi
--    UPSERT (INSERT ... ON CONFLICT), a meglévő 8-as lista összefésülésével.

-- ─────────────────────────────────────────────────────────────────────────────
-- 1. TELJES NULLÁZÁS: az 1-es alapok törlése
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.tv_doctor_baselines_clear(
  p_device_id text,
  p_device_token text
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_row public.tv_doctor_paired_devices%rowtype;
  v_hash text;
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

  -- 2.5.399: a Memória: 0 az 1-es alapot is törli (10. pont).
  -- Csak a saját, párosított eszköz alapjait; más TV adata érintetlen marad.
  delete from public.tv_doctor_channel_baselines where device_id = p_device_id;
  return true;
end;
$function$;

-- ─────────────────────────────────────────────────────────────────────────────
-- 2. VALÓDI UPSERT: új csatorna tanult útvonalai is elmentődnek
-- ─────────────────────────────────────────────────────────────────────────────
create or replace function public.tv_doctor_routes_upsert(
  p_device_id text,
  p_device_token text,
  p_payload jsonb
)
returns integer
language plpgsql
security definer
set search_path to 'public', 'extensions'
as $function$
declare
  v_row public.tv_doctor_paired_devices%rowtype;
  v_hash text;
  v_count integer := 0;
  v_item jsonb;
  v_routes jsonb;
  v_key text;
  v_name text;
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
    v_key := left(coalesce(v_item->>'channelKey', v_item->>'channel_key', ''), 120);
    if v_key = '' or v_key like 'vod:%' then continue; end if;
    if upper(coalesce(v_item->>'countryCode', v_item->>'country_code', '')) <> 'HU' then continue; end if;

    -- Csak érvényes formátum + pufferprofil, legfeljebb 8 tanult útvonal.
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
    v_name := left(coalesce(v_item->>'channelName', v_item->>'channel_name', v_key), 140);

    -- 2.5.399: INSERT ... ON CONFLICT. A régi függvény csak UPDATE-et végzett,
    -- ezért az új csatornák tanult útvonalai elvesztek (0 csatorna mentve).
    insert into public.tv_doctor_channel_profiles as p (
      channel_key, channel_name, country_code, routes, updated_at
    )
    values (v_key, v_name, 'HU', v_routes, now())
    on conflict (channel_key) do update
      set routes = coalesce((
            select jsonb_agg(merged.elem)
            from (
              select dedup.elem
              from (
                select distinct on (d.expr)
                       d.elem,
                       coalesce((d.elem->>'ok')::int, 0) as ok_count
                from (
                  select e.elem,
                         (e.elem->>'format') || ':' || (e.elem->>'bufferProfile') as expr
                  from unnest(array_cat(
                    array(select jsonb_array_elements(coalesce(p.routes, '[]'::jsonb))),
                    array(select jsonb_array_elements(coalesce(excluded.routes, '[]'::jsonb)))
                  )) as e(elem)
                ) d
                order by d.expr, coalesce((d.elem->>'ok')::int, 0) desc
              ) dedup
              order by dedup.ok_count desc
              limit 8
            ) merged
          ), '[]'::jsonb),
          country_code = coalesce(p.country_code, 'HU'),
          updated_at = now()
      where (p.country_code is null or upper(p.country_code) = 'HU');

    if found then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$function$;

-- A két RPC jogosultsági köre változatlan (anon / authenticated / service_role).
grant execute on function public.tv_doctor_baselines_clear(text, text) to anon, authenticated, service_role;
grant execute on function public.tv_doctor_routes_upsert(text, text, jsonb) to anon, authenticated, service_role;

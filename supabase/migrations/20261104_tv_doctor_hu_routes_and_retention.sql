-- ============================================================================
-- TV Doktor 2.5.294: TANULT ÚTVONALAK (csatornánként max. 8) + MAGYAR SZŰRÉS
-- + automatikus, korlátos tisztítás (hosszú távon ne halmozódjon felesleges adat)
-- ============================================================================
--
-- 1) Új `routes` mező: a csatorna legfeljebb 8 legjobb tanult útvonala
--    (formátum + pufferprofil együtt mérve). Csak számok és rövid azonosítók:
--    nincs benne stream URL, jelszó, film- vagy sorozatcím.
-- 2) CSAK a magyar csatornák tudása marad meg: a korábbi, más országokról
--    feltöltött sorok (pl. GB) törlődnek, és a jövőben sem kerülnek vissza.
-- 3) A karbantartó függvény mostantól a magyar szűrést és a 30 napos
--    esemény-megőrzést is elvégzi – a Edge Function minden szinkron után hívja.

alter table public.tv_doctor_channel_profiles
  add column if not exists routes jsonb not null default '[]'::jsonb;

comment on column public.tv_doctor_channel_profiles.routes is
  'A csatorna legfeljebb 8 tanult útvonala (formátum + pufferprofil, mért indulási idő, számlálók). Csak magyar csatornákra.';

create index if not exists tv_doctor_channel_profiles_country_idx
  on public.tv_doctor_channel_profiles (country_code, updated_at desc);

-- 1) Nem magyar sorok azonnali törlése (a felhasználói kérés: róluk ne legyen adat).
delete from public.tv_doctor_channel_profiles
where country_code is null or upper(country_code) <> 'HU';

-- 2) Olyan események törlése, amelyekhez már nincs magyar profil (1 napnál régebbiek).
delete from public.tv_doctor_events e
where e.created_at < now() - interval '1 day'
  and not exists (
    select 1 from public.tv_doctor_channel_profiles p where p.channel_key = e.channel_key
  );

-- 3) Korlátos karbantartás: magyar szűrés + 30 napos esemény-megőrzés + darabszám-korlát.
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
  -- Csak a magyar csatornák tudását őrizzük meg.
  delete from public.tv_doctor_channel_profiles
  where country_code is null or upper(country_code) <> 'HU';

  -- Elavult események (30 nap) és a már nem létező csatornák eseményei.
  delete from public.tv_doctor_events
  where created_at < now() - interval '30 days';

  delete from public.tv_doctor_events e
  where e.created_at < now() - interval '1 day'
    and not exists (
      select 1 from public.tv_doctor_channel_profiles p where p.channel_key = e.channel_key
    );

  -- Darabszám-korlát: a legutóbb frissült sorok maradnak.
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

-- ============================================================================
-- 4) TANULT ÚTVONALAK RPC – a TV Doktor párosított eszköze ezen keresztül
--    tölti fel és olvassa vissza a készülékenként tanult útvonalakat.
--    Az Edge Function telepítése nélkül is működik, és ugyanazt a védett
--    eszköztokent ellenőrzi, mint a tv-doctor Edge Function.
--
--    FONTOS: a pgcrypto függvényei a Supabase-ben az `extensions` sémában
--    vannak, ezért a search_path `public, extensions` (a `public` elöl marad,
--    hogy a függvény ne legyen eltéríthető).
-- ============================================================================

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
           ), '[]'::jsonb)
     where p.channel_key = v_key
       and (p.country_code is null or upper(p.country_code) = 'HU');

    if found then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.tv_doctor_routes_upsert(text, text, jsonb) from public;
grant execute on function public.tv_doctor_routes_upsert(text, text, jsonb) to anon, authenticated;

create or replace function public.tv_doctor_routes_fetch(
  p_device_id text,
  p_device_token text,
  p_limit integer default 400
)
returns table (channel_key text, country_code text, routes jsonb, updated_at timestamptz)
language plpgsql
security definer
set search_path = public, extensions
as $$
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

  return query
    select p.channel_key, p.country_code, p.routes, p.updated_at
    from public.tv_doctor_channel_profiles p
    where upper(coalesce(p.country_code, '')) = 'HU'
      and jsonb_array_length(coalesce(p.routes, '[]'::jsonb)) > 0
    order by p.updated_at desc
    limit greatest(1, least(coalesce(p_limit, 400), 600));
end;
$$;

revoke all on function public.tv_doctor_routes_fetch(text, text, integer) from public;
grant execute on function public.tv_doctor_routes_fetch(text, text, integer) to anon, authenticated;

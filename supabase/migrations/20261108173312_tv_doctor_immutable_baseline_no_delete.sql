-- 2.5.394 — AZ 1-ES ALAP ADATBÁZIS-SZINTEN IS MEGVÁLTOZTATHATATLAN.
--
-- A 20261107_tv_doctor_immutable_channel_baselines.sql még létrehozta a
-- `tv_doctor_baselines_clear()` RPC-t, és a 2.5.392 kliens a „Memória: 0”
-- gombnál meg is hívta: ilyenkor a TV ÉS a Supabase is elvesztette az 1-es
-- alapot, ezért nem volt hová visszatérni, és a tv -> Supabase -> tv kör
-- 0/80-on ragadt (#35–38 naplók).
--
-- Az új kliens már nem hívja ezt az RPC-t, de a RÉGI IPK-k (<= 2.5.392) még
-- igen. Ezért nem revokáljuk (akkor a régi kliens nullázása hibával bukna),
-- hanem a függvényt átírjuk: a párosított eszköznek továbbra is `true`-t ad
-- vissza, de TÖRLÉS NINCS. Így a régi IPK „Memória: 0” gombja is működik,
-- az 1-es alap viszont semmilyen kliensből nem törölhető.
--
-- Az alap írása továbbra is insert-only: `tv_doctor_baselines_upsert`
-- `ON CONFLICT DO NOTHING`, és a baseline `slot = 1` CHECK-kel védett.

create or replace function public.tv_doctor_baselines_clear(p_device_id text, p_device_token text)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  -- Az 1-es alap ZÁROLT. A hívás kompatibilitási okból sikert jelez, de a
  -- `tv_doctor_channel_baselines` tábla egyetlen sora sem törlődik.
  return true;
end;
$$;

comment on function public.tv_doctor_baselines_clear(text, text) is
  '2.5.394: az 1-es alap megváltoztathatatlan; a régi IPK-k kompatibilitási no-op-ja, NEM töröl baselinet.';

-- A jogosultságok változatlanok maradnak (create or replace megtartja a
-- proacl-t), hogy a régi IPK se kapjon 403-at a nullázásnál.

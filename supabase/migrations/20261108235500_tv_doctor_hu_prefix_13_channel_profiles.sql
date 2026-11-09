-- 2.5.401 – #43/#44 naplók és a 2026-11-08 23:43-as TV-fotó alapján.
--
-- A felhasználó végigjárta mind a 80 mentett magyar csatornát, mégis csak
-- 67 (később 72) tanult felhős profilt látott. A hiányzó adók KIVÉTEL NÉLKÜL
-- a `HU - …` (zárójel nélküli) névalakúak:
--   hu - travel channel, hu - pax tv, hu - filmbox stars hd, hu - story 4 hd,
--   hu - discovery investigation, hu - rtl ketto hd, hu - rtl 3,
--   hu - cartoonito, hu - life tv, hu - love nature, hu - pannon,
--   hu - tv2 comedy, hu - tv2 sef.
--
-- A deployed v18 Edge Function `layoutChannelKey()` már felismeri ezt a
-- prefixet és `hu:travel-channel` stabil kulcsot ad, de a kliens
-- `normalizeSavedLayoutChannelKey()` NEM: `hu-travel-channel`-t képzett.
-- A 80-as hatókör ezért 13 csatornát kizárt a `collectDoctorRoutePayload()`
-- -ból, így azok soha nem kerültek a `tv_doctor_channel_profiles` táblába.
-- A 2.5.401 kliensjavítás (kanonikus kulcs + prefix) ezt megszünteti.
--
-- Ez a migráció a MÁR ELVESZTETTNEK HITT, de a #44 TV Doktor naplóban
-- (`40d2d176-5507-4717-8700-0179db335199`) TÉNYLEGESEN MÉRT tanult
-- útvonalakat pótolja, hogy a Supabase azonnal 80/80-at mutasson, ne csak
-- a következő IPK-szinkron után. Minden szám a napló `TV DOKTOR INDÍTÁS`
-- sorából jön; nincs kitalált mérés. `ON CONFLICT DO NOTHING`: a TV által
-- időközben feltöltött, frissebb profilt SOHA nem írjuk felül.

insert into public.tv_doctor_channel_profiles (channel_key, channel_name, country_code, routes, updated_at)
values
  ('hu:travel-channel', '[HU] TRAVEL CHANNEL', 'HU',
   '[{"format":"ts","bufferProfile":"balanced","ok":3,"fail":0,"stalls":1,"avgStartupMs":1412,"bestStartupMs":1412,"lastOkAt":null,"lastFailAt":null}]'::jsonb, now()),
  ('hu:pax-tv', '[HU] PAX TV', 'HU',
   '[{"format":"hls","bufferProfile":"balanced","ok":3,"fail":2,"stalls":2,"avgStartupMs":1549,"bestStartupMs":1549,"lastOkAt":null,"lastFailAt":null}]'::jsonb, now()),
  ('hu:discovery-investigation', '[HU] DISCOVERY INVESTIGATION', 'HU',
   '[{"format":"ts","bufferProfile":"balanced","ok":3,"fail":0,"stalls":0,"avgStartupMs":1682,"bestStartupMs":1682,"lastOkAt":null,"lastFailAt":null}]'::jsonb, now()),
  ('hu:story-4-hd', '[HU] STORY 4 HD', 'HU',
   '[{"format":"hls","bufferProfile":"balanced","ok":1,"fail":0,"stalls":0,"avgStartupMs":1626,"bestStartupMs":1626,"lastOkAt":null,"lastFailAt":null}]'::jsonb, now()),
  ('hu:filmbox-stars-hd', '[HU] FILMBOX STARS HD', 'HU',
   '[{"format":"ts","bufferProfile":"balanced","ok":1,"fail":0,"stalls":0,"avgStartupMs":1269,"bestStartupMs":1269,"lastOkAt":null,"lastFailAt":null}]'::jsonb, now()),
  ('hu:rtl-ketto-hd', '[HU] RTL KETTO HD', 'HU',
   '[{"format":"ts","bufferProfile":"balanced","ok":2,"fail":0,"stalls":0,"avgStartupMs":1504,"bestStartupMs":1504,"lastOkAt":null,"lastFailAt":null}]'::jsonb, now()),
  ('hu:cartoonito', '[HU] CARTOONITO', 'HU',
   '[{"format":"hls","bufferProfile":"balanced","ok":1,"fail":0,"stalls":0,"avgStartupMs":1783,"bestStartupMs":1783,"lastOkAt":null,"lastFailAt":null}]'::jsonb, now()),
  ('hu:rtl-3', '[HU] RTL 3', 'HU',
   '[{"format":"hls","bufferProfile":"balanced","ok":0,"fail":0,"stalls":0,"avgStartupMs":null,"bestStartupMs":null,"lastOkAt":null,"lastFailAt":null}]'::jsonb, now()),
  ('hu:life-tv', '[HU] LIFE TV', 'HU',
   '[{"format":"hls","bufferProfile":"balanced","ok":1,"fail":0,"stalls":0,"avgStartupMs":1853,"bestStartupMs":1853,"lastOkAt":null,"lastFailAt":null}]'::jsonb, now()),
  ('hu:love-nature', '[HU] LOVE NATURE', 'HU',
   '[{"format":"hls","bufferProfile":"balanced","ok":1,"fail":0,"stalls":0,"avgStartupMs":1949,"bestStartupMs":1949,"lastOkAt":null,"lastFailAt":null}]'::jsonb, now()),
  ('hu:pannon', '[HU] PANNON', 'HU',
   '[{"format":"hls","bufferProfile":"balanced","ok":1,"fail":0,"stalls":0,"avgStartupMs":1708,"bestStartupMs":1708,"lastOkAt":null,"lastFailAt":null}]'::jsonb, now()),
  ('hu:tv2-comedy', '[HU] TV2 COMEDY', 'HU',
   '[{"format":"hls","bufferProfile":"balanced","ok":2,"fail":0,"stalls":0,"avgStartupMs":1603,"bestStartupMs":1603,"lastOkAt":null,"lastFailAt":null}]'::jsonb, now()),
  ('hu:tv2-sef', '[HU] TV2 SEF', 'HU',
   '[{"format":"ts","bufferProfile":"balanced","ok":1,"fail":0,"stalls":0,"avgStartupMs":1568,"bestStartupMs":1568,"lastOkAt":null,"lastFailAt":null}]'::jsonb, now())
on conflict (channel_key) do nothing;

-- ============================================================================
-- TV Doktor v2: Gyors indítási profilok (instant / turbo), EPG és halott-csatorna
-- események engedélyezése + a korábbi clampInt(null -> 20ms) helyőrzők tisztítása
-- ============================================================================

ALTER TABLE public.tv_doctor_channel_profiles
  DROP CONSTRAINT IF EXISTS tv_doctor_channel_profiles_best_buffer_ahead_seconds_check;

ALTER TABLE public.tv_doctor_channel_profiles
  ADD CONSTRAINT tv_doctor_channel_profiles_best_buffer_ahead_seconds_check
  CHECK (best_buffer_ahead_seconds >= 0.5 AND best_buffer_ahead_seconds <= 10.0);

ALTER TABLE public.tv_doctor_channel_profiles
  DROP CONSTRAINT IF EXISTS tv_doctor_channel_profiles_best_buffer_profile_check;

ALTER TABLE public.tv_doctor_channel_profiles
  ADD CONSTRAINT tv_doctor_channel_profiles_best_buffer_profile_check
  CHECK (best_buffer_profile = ANY (ARRAY[
    'instant'::text,
    'turbo'::text,
    'fast'::text,
    'balanced'::text,
    'stable'::text,
    'adaptive-1'::text,
    'adaptive-2'::text,
    'adaptive-3'::text
  ]));

ALTER TABLE public.tv_doctor_events
  DROP CONSTRAINT IF EXISTS tv_doctor_events_event_type_check;

ALTER TABLE public.tv_doctor_events
  ADD CONSTRAINT tv_doctor_events_event_type_check
  CHECK (event_type = ANY (ARRAY[
    'measurement'::text,
    'diagnostic'::text,
    'speed_test'::text,
    'buffer_test'::text,
    'repair_attempt'::text,
    'repair_verified'::text,
    'repair_exhausted'::text,
    'freeze_detected'::text,
    'channel_dead'::text,
    'epg_assist'::text,
    'epg_disabled'::text
  ]));

-- Tisztítás: 0 sikeres mérésnél vagy a régi 20 ms-os clampInt(null) helyőrzőnél
-- töröljük a hamis 20 ms-os átlagokat és újraszámoljuk a legjobb formátumot/indulást.
UPDATE public.tv_doctor_channel_profiles
SET
  ts_avg_startup_ms = CASE
    WHEN COALESCE(ts_success_count, 0) <= 0 OR COALESCE(ts_avg_startup_ms, 0) <= 20 THEN NULL
    ELSE ts_avg_startup_ms
  END,
  hls_avg_startup_ms = CASE
    WHEN COALESCE(hls_success_count, 0) <= 0 OR COALESCE(hls_avg_startup_ms, 0) <= 20 THEN NULL
    ELSE hls_avg_startup_ms
  END;

UPDATE public.tv_doctor_channel_profiles
SET
  best_startup_ms = CASE
    WHEN COALESCE(ts_success_count, 0) + COALESCE(hls_success_count, 0) <= 0 THEN NULL
    WHEN ts_avg_startup_ms IS NOT NULL AND hls_avg_startup_ms IS NOT NULL THEN LEAST(ts_avg_startup_ms, hls_avg_startup_ms)
    WHEN ts_avg_startup_ms IS NOT NULL THEN ts_avg_startup_ms
    WHEN hls_avg_startup_ms IS NOT NULL THEN hls_avg_startup_ms
    WHEN best_startup_ms IS NOT NULL AND best_startup_ms > 20 THEN best_startup_ms
    ELSE NULL
  END,
  best_format = CASE
    WHEN COALESCE(ts_success_count, 0) > 0 AND COALESCE(hls_success_count, 0) = 0 THEN 'ts'
    WHEN COALESCE(hls_success_count, 0) > 0 AND COALESCE(ts_success_count, 0) = 0 THEN 'hls'
    WHEN COALESCE(ts_success_count, 0) > 0 AND COALESCE(hls_failure_count, 0) >= COALESCE(ts_failure_count, 0) + 5 THEN 'ts'
    WHEN COALESCE(hls_success_count, 0) > 0 AND COALESCE(ts_failure_count, 0) >= COALESCE(hls_failure_count, 0) + 5 THEN 'hls'
    ELSE best_format
  END;

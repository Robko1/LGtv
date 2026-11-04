-- A kézi napló küldés újrapróbája ne tudjon párhuzamos dupla rekordot létrehozni.
-- A régi, QR-korszakbeli rekordok log_number nélkül is megmaradhatnak.
CREATE UNIQUE INDEX IF NOT EXISTS tv_diagnostic_shares_log_session_unique
  ON public.tv_diagnostic_shares (log_number, started_at)
  WHERE log_number IS NOT NULL AND started_at IS NOT NULL;

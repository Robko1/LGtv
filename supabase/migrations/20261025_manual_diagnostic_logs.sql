-- Kézi, QR nélküli hibakeresési napló az utolsó öt rekordhoz.
-- A tábla korábbi token_hash mezője kompatibilitásból megmarad; az új Edge
-- Function belső hash-t tárol, abból nem készül publikus URL vagy QR-kód.
alter table public.tv_diagnostic_shares
  add column if not exists log_number bigint,
  add column if not exists started_at timestamptz;

create index if not exists tv_diagnostic_shares_log_number_created_idx
  on public.tv_diagnostic_shares (log_number desc nulls last, created_at desc);

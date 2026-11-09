#!/usr/bin/env bash
# 2.5.395 — A `tv-doctor` Edge Function (v19) élesítése.
#
# A funkció FORRÁSA a `supabase/functions/tv-doctor/index.ts`, és a 2.5.394
# PR óta a `main`-en van. A futó függvény azonban még a v18-as deploy, amely
# az elavult layout-ID-kre szűr. A kliens visszafelé kompatibilis (lásd
# `tools/test-tv-doctor-cloud-v18-compat.mjs`), de a SZERVEROLDALI névkulcsos
# hatókör, a `layoutChannels`/`baselines` bootstrap és a megőrző reset csak
# az alábbi deploy után él.
#
# Használat (saját Supabase CLI + saját access token kell hozzá):
#
#   export SUPABASE_ACCESS_TOKEN='<saját Supabase access token>'
#   ./tools/deploy-tv-doctor.sh
#
# A token NEM kerül a repóba, NEM kerül naplóba, és a script nem írja ki.
# A deploy NEM töröl adatot: a profilok, az 1-es alapok és a mentett 80
# magyar csatorna elrendezése a helyén marad.

set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-hlklmcujvqsatwvdygqp}"
FUNCTION_SLUG="tv-doctor"

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "HIÁNYZÓ TOKEN: állítsd be a SUPABASE_ACCESS_TOKEN környezeti változót." >&2
  echo "  export SUPABASE_ACCESS_TOKEN='<saját Supabase access token>'" >&2
  exit 1
fi

if ! command -v supabase >/dev/null 2>&1; then
  echo "HIÁNYZÓ SUPABASE CLI: npm i -g supabase" >&2
  exit 1
fi

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ ! -f "supabase/functions/${FUNCTION_SLUG}/index.ts" ]]; then
  echo "HIÁNYZÓ FORRÁS: supabase/functions/${FUNCTION_SLUG}/index.ts" >&2
  exit 1
fi

echo "tv-doctor deploy: ${FUNCTION_SLUG} -> ${PROJECT_REF} (forrás: 2.5.394/395, v19)"
supabase functions deploy "${FUNCTION_SLUG}" \
  --project-ref "${PROJECT_REF}" \
  --no-verify-jwt

echo "KÉSZ. Ellenőrzés: a TV Doktor naplóban a 'TV DOKTOR SUPABASE KÖR' sorban"
echo "a 'mentett_központi_profilok' és az '1-es_alap' értéke nem 0."

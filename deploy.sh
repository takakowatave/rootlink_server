#!/bin/bash
set -e

: "${SUPABASE_URL:?SUPABASE_URL is required}"
: "${SUPABASE_ANON_KEY:?SUPABASE_ANON_KEY is required}"

gcloud run deploy rootlink-server-v2 \
  --source . \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --clear-base-image \
  --set-build-env-vars="SUPABASE_URL=${SUPABASE_URL},SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}" \
  --set-env-vars="SUPABASE_URL=${SUPABASE_URL},SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY}"

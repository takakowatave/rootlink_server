#!/bin/bash
set -e

# 本番デプロイは main からのみ。develop や feature branch から誤って
# 打つのを防ぐため、ブランチが main でなければ止まる。
current_branch=$(git rev-parse --abbrev-ref HEAD)
if [ "$current_branch" != "main" ]; then
  echo "deploy.sh: 本番デプロイは main からのみ。現在のブランチ: $current_branch" >&2
  exit 1
fi

# 環境変数は Cloud Run 側に設定済みなので、ここでは注入しない。
gcloud run deploy rootlink-server-v2 \
  --source . \
  --region asia-northeast1 \
  --allow-unauthenticated \
  --clear-base-image

# デプロイ後の最新リビジョン名を表示（ロールバック時に一目でわかるように）
latest_revision=$(gcloud run services describe rootlink-server-v2 \
  --region asia-northeast1 \
  --format="value(status.latestReadyRevisionName)")
echo "deploy.sh: latest ready revision = $latest_revision"

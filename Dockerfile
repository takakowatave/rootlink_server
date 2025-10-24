# ベースイメージ
FROM node:20-alpine

# 作業ディレクトリ
WORKDIR /app

# パッケージファイルをコピー
COPY package*.json ./

# 依存関係をインストール（開発依存も含める）
RUN npm ci --include=dev

# ソースコードをコピー
COPY . .

# TypeScriptをビルド（dist/ に出力）
RUN npm run build

# Cloud Run用ポート設定
ENV PORT=8080
EXPOSE 8080

# ✅ 起動コマンド（npm start ではなく直接 node 実行）
CMD ["node", "dist/index.js"]

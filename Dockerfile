FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./

# ✅ devDependencies も含めて必ず全部インストール
RUN npm install --omit=dev=false

# ✅ 念のため TypeScript を明示的にインストール
RUN npm install typescript -g

# Copy app files
COPY . .

# Build the project (TypeScript → JS)
RUN npm run build

ENV PORT=8080
EXPOSE 8080

CMD ["npm", "start"]

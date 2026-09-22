# ----------------------------
# 1. Dependencies
# ----------------------------
FROM node:24-alpine AS deps

WORKDIR /app

COPY package*.json ./

RUN npm ci


# ----------------------------
# 2. Build
# ----------------------------
FROM node:24-alpine AS build

WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

RUN npm run build


# ----------------------------
# 3. Production
# ----------------------------
FROM node:24-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

USER node

EXPOSE 3000

CMD ["node", "dist/main.js"]
FROM node:24-alpine AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --workspace backend
COPY backend backend
RUN npm run build --workspace backend

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --workspace backend
COPY --from=build /app/backend/dist backend/dist
COPY backend/db backend/db
WORKDIR /app/backend
EXPOSE 4000
CMD ["node", "dist/server.js"]


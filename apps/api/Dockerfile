FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY prisma ./prisma
RUN npx prisma generate
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ENV NODE_ENV=production
ENV WHATSAPP_AUTH_DIR=/data/whatsapp-auth
WORKDIR /app
RUN apk add --no-cache ffmpeg && mkdir -p /data/whatsapp-auth && chmod 700 /data/whatsapp-auth
COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/dist ./dist
EXPOSE 4000
CMD ["sh", "-c", "npx prisma db push && npm run db:replace-catalog && node dist/src/server.js"]

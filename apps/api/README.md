# Bondoq Backend

Backend-only package: Prisma schema and seed data, JWT authentication and role guards, KalemlyWA WhatsApp plus Messenger and Telegram webhooks, least-active-agent routing, queued WhatsApp delivery, BullMQ SLA checks, and authenticated Socket.IO events.

## Local setup

1. Start PostgreSQL and Redis, then copy `.env.example` to `.env` and set the database URL, a unique JWT secret, and account passwords before a production seed.
2. Run `npm install`.
3. Run `npm run db:generate`, `npm run db:push`, and `npm run db:seed`.
4. Run `npm run dev`; the API listens on port `4000` by default.

## Main endpoints

- `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`
- `GET /api/products`, `GET/POST/PATCH /api/admin/products`
- `POST /api/conversations/:id/products`
- `GET/PUT /api/admin/integrations/kalemlywa`, `POST /api/admin/integrations/kalemlywa/test`
- `POST /api/conversations/:id/orders` accepts `referenceImageMessageId`; `PATCH /api/conversations/:id/status` with `RESOLVED` sends CSAT.
- `POST /webhooks/kalemlywa` for KalemlyWA WhatsApp events; it requires `x-kalemly-webhook-secret` matching `KALEMLYWA_WEBHOOK_SECRET`.
- `GET /webhooks/meta` and `POST /webhooks/meta` for Facebook Messenger events only.
- `POST /webhooks/telegram` for Telegram Bot API updates
- Socket.IO authenticates with `{ auth: { token } }`; it emits inbox, message, whisper, presence, and SLA events to role-scoped rooms.

Local demo account passwords are in `prisma/seed.ts`. In production, set `BONDOQ_ADMIN_PASSWORD` and `BONDOQ_AGENT_PASSWORD` before seeding; quality can use `BONDOQ_QUALITY_PASSWORD` or the agent password. Seeding no longer resets existing passwords. Real channel traffic requires provider credentials, public HTTPS webhook URLs, and provider-side app configuration.

Set `KALEMLYWA_API_URL` (defaults to `https://whatsapp.kalemly.com/api/send-message`) and `KALEMLYWA_WEBHOOK_SECRET`. Configure separate `KALEMLYWA_AUTH_KEY` and `KALEMLYWA_APP_KEY` values, or enter both in the dashboard; both are encrypted at rest. `KALEMLYWA_API_KEY` remains a legacy fallback for accounts that use one shared key. The KalemlyWA send-message API does not require an instance ID. The QR screen accepts an optional payload copied from KalemlyWA because no QR-fetch endpoint is assumed. Set `META_PAGE_ACCESS_TOKEN`, `META_APP_SECRET`, and `META_VERIFY_TOKEN` for Messenger. Messenger replies stop outside its 24-hour window; WhatsApp delivery is queued and is not restricted by the Meta window. Set `OPENAI_API_KEY` to enable audio transcription; without it audio is still saved and playable but is not transcribed. Seed products and demo accounts are examples: replace product names, prices, and image links before customer use.

For Railway, use `/apps/api` as the service root. Set `TELEGRAM_BOT_TOKEN` to enable Telegram; `KALEMLYWA_CONFIG_ENCRYPTION_KEY` can override the encryption key derived from `JWT_SECRET`.

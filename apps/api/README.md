# Bondoq Backend

Backend-only package: Prisma schema and seed data, JWT authentication and role guards, KalemlyWA WhatsApp plus Messenger and Telegram webhooks, Redis-backed round-robin routing, queued WhatsApp delivery, BullMQ SLA checks, and authenticated Socket.IO events.

## Local setup

1. Start PostgreSQL and Redis, then copy `.env.example` to `.env` and set the database URL, a unique JWT secret, and account passwords before a production seed.
2. Run `npm install`.
3. Run `npm run db:generate`, `npm run db:push`, and `npm run db:seed`.
4. Run `npm run dev`; the API listens on port `4000` by default.

## Main endpoints

- `POST /api/auth/login`, `GET /api/auth/me`, `POST /api/auth/logout`
- Password recovery for all account roles: `POST /api/auth/password-reset/request`, approval via a system admin at `/api/admin/password-reset-requests` or a one-time recovery-email approval link at `POST /api/auth/password-reset/approve-by-email`, and one-time completion at `/api/auth/password-reset/complete`.
- `GET /api/products`, `GET/POST/PATCH /api/admin/products`
- `POST /api/conversations/:id/products`
- `PATCH /api/conversations/:id/customer` saves the staff display name and notes for the customer attached to an assigned conversation.
- `GET/PUT /api/admin/integrations/kalemlywa`, `POST /api/admin/integrations/kalemlywa/test`
- `GET/PUT /api/admin/chatbot-settings` manages the service menu, welcome/invalid-choice text, and handoff replies.
- `POST /api/conversations/:id/orders` saves order details; customer media remains in the conversation history. `PATCH /api/conversations/:id/status` with `RESOLVED` sends CSAT.
- `POST /webhooks/kalemlywa` for KalemlyWA WhatsApp events; it accepts an HMAC-derived `token` query parameter tied to the configured webhook secret or saved app key, or a matching credential in supported headers/request fields. The admin dashboard generates the complete URL. Requests without a matching credential are rejected.
- `GET /webhooks/meta` and `POST /webhooks/meta` for Facebook Messenger and WhatsApp Business Calling events.
- Agent endpoints check calling permission, send a permission request, start a WebRTC call, poll signaling state, and terminate a call.
- `POST /webhooks/telegram` for Telegram Bot API updates
- Socket.IO authenticates with `{ auth: { token } }`; it emits inbox, message, whisper, presence, and SLA events to role-scoped rooms.

Local demo account passwords are in `prisma/seed.ts`. In production, set `BONDOQ_ADMIN_PASSWORD` and `BONDOQ_AGENT_PASSWORD` before seeding; quality can use `BONDOQ_QUALITY_PASSWORD` or the agent password. Seeding no longer resets existing passwords. Real channel traffic requires provider credentials, public HTTPS webhook URLs, and provider-side app configuration.

For desktop and Android notifications while the app is minimized or closed, configure `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, and `VAPID_SUBJECT` on the API, then each user must enable notifications from the bell button on each browser/device. On iPhone/iPad, install the site from Safari using Add to Home Screen (iOS/iPadOS 16.4 or later), open the installed app, and allow notifications. The service worker delivers OS notifications while the page is hidden; notification sound follows browser and operating-system notification settings and cannot be forced to a custom sound by the web app.

Login tokens do not expire automatically. Closing a tab or losing its connection does not log out an employee, change their availability, or release their conversations. The Logout button explicitly revokes the session; disabling an account or changing its authorization version also revokes existing sessions.

Set `KALEMLYWA_API_URL` (defaults to `https://whatsapp.kalemly.com/api/send-message`) and a strong, unique `KALEMLYWA_WEBHOOK_SECRET`. Configure separate `KALEMLYWA_AUTH_KEY` and `KALEMLYWA_APP_KEY` values, or enter both in the dashboard; both are encrypted at rest. The dashboard copies the full inbound URL with an HMAC-derived authentication token; paste the complete URL into KalemlyWA and do not share it publicly. KalemlyWA's documented webhook setup sends JSON to a URL and does not expose a custom header field. If callbacks still return 401 after updating the URL, inspect the provider delivery record; do not disable authentication. `KALEMLYWA_API_KEY` remains a legacy fallback for accounts that use one shared key. The KalemlyWA send-message API does not require an instance ID. The QR screen accepts an optional payload copied from KalemlyWA because no QR-fetch endpoint is assumed. Set `META_PAGE_ACCESS_TOKEN`, `META_APP_SECRET`, and `META_VERIFY_TOKEN` for Messenger. Messenger replies stop outside its 24-hour window; WhatsApp delivery is queued and is not restricted by the Meta window. Set `OPENAI_API_KEY` to enable audio transcription; without it audio is still saved and playable but is not transcribed. Seed products and demo accounts are examples: replace product names, prices, and image links before customer use.

For Railway, use `/apps/api` as the service root. Set `TELEGRAM_BOT_TOKEN` to enable Telegram; `KALEMLYWA_CONFIG_ENCRYPTION_KEY` can override the encryption key derived from `JWT_SECRET`.

Password recovery requests work for all active account roles. A system administrator can approve requests in the dashboard, or the owner of `PASSWORD_RESET_RECOVERY_EMAIL` can confirm via a one-time email link (defaults to `mahmoudsalamagsm@gmail.com`), allowing a sole administrator to recover access. Approval links expire after one hour; reset links expire after 30 minutes and can be used once. Configure `RESEND_API_KEY` and a verified sender address in `EMAIL_FROM`; configure `WEB_ORIGIN` to the deployed web origin so links point to the live app.

Live outbound WhatsApp calls run directly in the agent workspace using WhatsApp Business Calling API and browser WebRTC; the agent does not open WhatsApp Web. Configure `WHATSAPP_CLOUD_PHONE_NUMBER_ID`, `WHATSAPP_CLOUD_ACCESS_TOKEN`, `WHATSAPP_CLOUD_API_VERSION`, and a separate webhook verify token. The configured Cloud API phone number is checked against Ireland's `+353` code before every call operation. Subscribe the Meta app to the WhatsApp Business Account `calls` field and to messages so the call permission reply is delivered to Meta. The callback URL remains `https://<api-domain>/webhooks/meta`.

The Cloud API number must have Calling enabled, use a supported Irish business number, have the required WhatsApp Business Platform permissions, and be configured to receive Meta webhooks. Meta currently requires a daily messaging limit of at least 2,000 unique recipients for Calling API use. WhatsApp requires each customer to grant call permission before a business-initiated call. The UI can request permission with an interactive message; configure an approved template name and language in `WHATSAPP_CLOUD_CALL_PERMISSION_TEMPLATE` and `WHATSAPP_CLOUD_CALL_PERMISSION_LANGUAGE` if the request must be sent outside an open Cloud API customer-service window. The permission template must include a `call_permission_request` component. Meta's Graph token is kept in API environment variables and is never returned to the browser.

The existing Kalemly/Baileys number continues to handle the existing chat messages and incoming-call rejection. Outbound system calls use the Irish Cloud API line, so customers will see that number as the caller. Baileys incoming-call notifications are not live audio calls; audio attachments remain voice notes, not calls.

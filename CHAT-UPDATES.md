# Chat updates

## Included in this update

- Added cursor-based conversation pages and an inbox control to load the next 50 conversations. The original unpaged API response remains available for existing clients.
- Added bounded message-history pages and a control to load older messages while preserving the existing message order.
- Added per-user customer favorites and conversation pins, including the CRM favorites filter and inbox pinned filter.
- Added click-to-enlarge image preview and lazy loading for protected message attachments.
- Limited conversation whisper/internal-note history to the latest 100 items per conversation request.
- Added native text editing for delivered agent messages in Telegram and Baileys WhatsApp, plus ingestion of Telegram `edited_message` updates.
- Added copy-forwarding between authorized conversations. Provider media is cached only when needed for forwarding, with a 12 MiB limit for fetched media.
- Added WebP sticker send/receive support for Telegram and Baileys WhatsApp.
- Added Telegram/Baileys WhatsApp message reactions and Baileys read/delivery receipt synchronization.
- Added single-choice poll creation for Telegram and Baileys WhatsApp, with poll question/options shown in the workspace.
- Added outbound WhatsApp Business Calling API calls from the agent workspace, with WebRTC audio, customer permission checks, and call lifecycle webhooks.
- Added a Baileys-compatible browser-call fallback: send a short-lived, single-call invitation over WhatsApp, then bridge employee and customer browsers with WebRTC. This is not a native WhatsApp voice call.
- Hardened call status polling against stale updates and duplicate SDP answer application; customer consent to recording and AI processing is independent and optional.
- Added configurable Cairo business hours. Outside hours, the chatbot menu is bypassed, a configurable reply is sent at most once per conversation per Cairo day, and the conversation is queued for staff.
- Added opt-in WebRTC call recording for new WhatsApp Cloud Calling calls. The agent must attest to the customer's explicit consent before calling; both audio streams are mixed locally and stored as a protected recording after the call.
- Added supervisor-controlled optional AI transcription and summaries for WhatsApp Cloud call recordings. The agent records separate customer consent for recording and for sending audio/transcript to OpenAI; audio stays local to the app when AI processing is off or either consent is absent.
- Added AI processing status/error reporting to the call audit screen; supervisors can review and correct the generated transcript and summary. Recording playback, processing consent, and review actions are audited.
- Permanent conversation/customer deletion also removes unreferenced call-recording media.

## Data and deployment

The Prisma schema adds `CustomerFavorite`, `ConversationPin`, `WhatsAppCallSession`, `CallRecording`, `CallRecordingSettings`, and chatbot business-hours fields, and extends `MessageKind` with `STICKER` and `POLL`. Recording and AI processing are both disabled by default. The existing deployment startup runs `prisma db push`, which applies the schema changes when the service starts. Railway runs separate API and web services from `/apps/api` and `/apps/web`, both connected to `main`.

Outbound calling needs an activated Irish (+353) WhatsApp Cloud API number, Calling enabled, subscribed `calls` and `messages` webhooks, customer permission, and a Meta daily messaging limit of at least 2,000 unique recipients. Configure the Cloud API credentials on the API service; no live provider call was available during this update's validation.

In Baileys mode, the CRM sends a 10-minute browser-call link through WhatsApp; the customer must open it and allow microphone access. This does not answer or bridge a native WhatsApp call. Configure `WEBRTC_TURN_URLS` and `WEBRTC_TURN_SHARED_SECRET` with a coturn server for reliable connections across restrictive NATs; STUN-only connections are best-effort.

After deployment, re-register the Telegram webhook once from its integration settings so Telegram includes `edited_message` updates.

## Remaining channel limitations

- Text edits are provider-synced only for already-delivered messages authored by the current agent in Telegram or Baileys WhatsApp. Messenger's edit action is hidden and the API returns a clear conflict rather than attempting a risky delete-and-resend; WhatsApp API mode also does not support this edit flow.
- Forwarding creates a copy in the destination conversation, not a native provider-attributed forward. Forwarding older media may fail if it cannot be fetched from a trusted provider host or is larger than 12 MiB.
- Stickers require WebP and are available only in Telegram and Baileys WhatsApp. Messenger and WhatsApp API mode do not support sticker sending.
- Poll creation is available only in Telegram and Baileys WhatsApp. Provider votes/results are not synchronized into the CRM, and sent polls cannot be edited through the available provider APIs.
- Native reactions synchronize in Telegram and Baileys WhatsApp. Messenger and WhatsApp API mode retain reactions in the CRM only.
- Opening a conversation sends WhatsApp read receipts only in Baileys mode; Baileys delivery/read acknowledgements update the message status. Telegram's Bot API and the current Messenger/API integrations do not expose equivalent read receipts here.
- Quote references remain visible in the CRM but are not sent as provider-native quoted replies.
- Native incoming WhatsApp calls can be rejected or opened as conversations; Baileys does not support accepting/carrying native WhatsApp call audio. Browser calls use the separate invitation link described above.

## Validation

- Web service-worker tests pass (2), WebRTC security tests pass (3), API server/config syntax checks pass under Node's TypeScript stripping mode, and invitation-token/coturn credential checks pass. This workspace has no npm/tsc executable or installed dependencies; the full API suite, Prisma validation, and Next.js type-check/build could not be run. End-to-end audio was not tested against live browsers/networks; production calling needs the web/API HTTPS origins and a TURN service for reliable connectivity across restrictive NATs.

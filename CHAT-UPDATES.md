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

## Data and deployment

The Prisma schema adds `CustomerFavorite` and `ConversationPin`, and extends `MessageKind` with `STICKER` and `POLL`. The existing deployment startup runs `prisma db push`, which applies the schema changes when the service starts. Railway runs separate API and web services from `/apps/api` and `/apps/web`, both connected to `main`.

After deployment, re-register the Telegram webhook once from its integration settings so Telegram includes `edited_message` updates.

## Remaining channel limitations

- Text edits are provider-synced only for already-delivered messages authored by the current agent in Telegram or Baileys WhatsApp. Messenger and WhatsApp API mode do not support this edit flow.
- Forwarding creates a copy in the destination conversation, not a native provider-attributed forward. Forwarding older media may fail if it cannot be fetched from a trusted provider host or is larger than 12 MiB.
- Stickers require WebP and are available only in Telegram and Baileys WhatsApp. Messenger and WhatsApp API mode do not support sticker sending.
- Poll creation is available only in Telegram and Baileys WhatsApp. Provider votes/results are not synchronized into the CRM, and sent polls cannot be edited through the available provider APIs.
- Native reactions synchronize in Telegram and Baileys WhatsApp. Messenger and WhatsApp API mode retain reactions in the CRM only.
- Opening a conversation sends WhatsApp read receipts only in Baileys mode; Baileys delivery/read acknowledgements update the message status. Telegram's Bot API and the current Messenger/API integrations do not expose equivalent read receipts here.
- Quote references remain visible in the CRM but are not sent as provider-native quoted replies.
- Incoming WhatsApp calls can be rejected or opened as conversations; answering and routing live call audio is not implemented by the current Baileys integration.

## Validation

API source syntax checks pass under Node's TypeScript stripping mode, and the existing web service-worker tests pass (2). This workspace has no npm/tsc executable or installed project dependencies, so Prisma validation, full TypeScript type-check/build, and the API test suite could not be run here. Provider behavior was not tested against live channel credentials.

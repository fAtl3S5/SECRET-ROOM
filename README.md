# SECRET ROOM — Telegram bots

Автономный Node.js-процесс для BotHost: бот-переходник, бот платных подписок, Crypto Pay, автоматическая выдача приглашения и удаление после окончания подписки.

Команда запуска: `npm run bot:start`. Переменные окружения перечислены в `.env.example`; токены хранятся только в настройках хостинга.

Bot: https://t.me/Secretroom2_app

`/start` in a private chat returns a greeting and one button, «🔐 Войти в канал».
The invitation is configured outside the source. No user database or broadcasts.

## Runtime configuration

Set both values as Sites secrets, then deploy:
- `TELEGRAM_WEBHOOK_SECRET`: random URL-safe secret, 32–256 characters.
- `TELEGRAM_CHANNEL_URL`: the owner's exact Telegram invitation.

The bot token is used only for Telegram `setWebhook`; the deployed code does not need it.
The handler uses the documented webhook reply mechanism (`method: sendMessage`).

## Activation

Webhook: `POST /telegram/webhook`. Telegram must reach the HTTPS endpoint without ChatGPT sign-in. A new Site remains owner-private until the owner authorizes changing access.

After access is configured, call Telegram `setWebhook` with the deployed URL, matching `secret_token`, `allowed_updates: ["message"]`, `max_connections: 10`, and `drop_pending_updates: false`.
Never put the bot token, invitation or webhook secret into source, logs or public pages.

The handler authenticates the request, ignores groups and unrelated commands, caps body size and stores no chat IDs or messages. Webhook replies do not provide a separate delivery receipt. Replayed requests may repeat the welcome; no persistent deduplication store is used.

## Checks

`node --experimental-strip-types --test tests/telegram.test.mjs`

Build and publish using the Sites skill's normal source workflow.
Official API: https://core.telegram.org/bots/api#making-requests-when-getting-updates

# SECRET ROOM — Telegram bots

Автономный Node.js-процесс для BotHost: бот-переходник, бот платных подписок, Crypto Pay + BigPay (RUB), автоматическая выдача приглашения и удаление после окончания подписки.

Команда запуска: `npm run bot:start` (или `node bot.js`). Переменные окружения перечислены в `.env.example`; токены хранятся только в настройках хостинга.

Bot: https://t.me/Secretroom2_app

## Тарифы

| План | USD (Crypto Pay) | RUB (BigPay) |
|------|------------------|--------------|
| 7 дней | $5 | 299 ₽ |
| Месяц | $9 | 699 ₽ |
| 3 месяца | $20 | 1799 ₽ |
| Навсегда | $35 | 2990 ₽ |

## Оплата

1. **Crypto Pay** — инвойс в USD, USDT и другие активы Crypto Bot.
2. **BigPay (RUB)** — три кнопки в боте ([docs](https://bigpay.site/docs)):
   - **СБП и др.** — `POST /api/v1/create_paylink`; плательщик выбирает метод на `/pay/{external_id}`
   - **СБП напрямую** — `create_paylink` + `get_requisites` с `type: "sbp"`
   - **Карта (Stripe)** — `POST /api/v1/create_stripe_paylink` (нужен включённый Stripe у магазина)

`get_requisites` `type`: `sbp` | `crypto` | `cryptobot` | `stripe`. Нативный C2C / SberPay на форме BigPay пока недоступен; карты — только через Stripe.

Статусы: `PENDING` → `CONFIRMED` → `COMPLETED`. Бот поллит `check_status` (как Crypto Pay) и принимает shop webhook; fulfilment общий.

После `COMPLETED` бот выдаёт одноразовый инвайт в канал так же, как при крипто-оплате.

## Secrets на BotHost

Обязательные:

- `GATEWAY_BOT_TOKEN`
- `SUBSCRIPTION_BOT_TOKEN`
- `CRYPTO_PAY_API_TOKEN`
- `PAID_CHANNEL_ID`

Для RUB / BigPay:

- `BIGPAY_API_TOKEN` — API-ключ магазина (`sk_live_...` / `sk_test_...`), заголовок `X-API-Key` (также поддерживается `Authorization: Bearer …`). Только из env, не коммитить.
- `BIGPAY_WEBHOOK_SECRET` — необязательный секрет в пути webhook (`/bigpay/webhook/<secret>`), чтобы чужие POST не принимались. Тот же путь укажите в кабинете BigPay → webhook магазина.
- `PUBLIC_BASE_URL` — публичный HTTPS origin BotHost (без слэша в конце), чтобы в логах подсказать полный URL webhook.

Пример webhook URL для кабинета BigPay:

`https://<your-bothost-host>/bigpay/webhook/<BIGPAY_WEBHOOK_SECRET>`

Опубликованные docs BigPay не описывают HMAC подписи webhook. Бот при любом callback заново проверяет платёж через `POST /api/v1/check_status` и активирует доступ только при `COMPLETED` + совпадении суммы/валюты. Параллельно раз в 30 с идёт polling (как у Crypto Pay).

Опциональные каналы / пути:

- `MAIN_CHANNEL_URL`, `SAFE_CHANNEL_URL`, `SUBSCRIPTION_BOT_URL`
- `DATA_FILE`, `PORT`

## API BigPay (используется ботом)

Base: `https://bigpay.site/api` — все методы `POST` JSON, auth `X-API-Key` из `BIGPAY_API_TOKEN`.

- `POST /v1/create_paylink` — RUB paylink (chooser)
- `POST /v1/get_requisites` — прямые реквизиты (`type: sbp` и др.)
- `POST /v1/create_stripe_paylink` — Stripe Checkout
- `POST /v1/check_status` — статус
- Webhook магазина → `POST /bigpay/webhook[...]` на этом сервисе

## Health

`GET /health` — `{ ok, bigpay, webhookPath }`.

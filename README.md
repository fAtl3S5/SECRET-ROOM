# SECRET ROOM — Telegram bots

Автономный Node.js-процесс для хостинга (BotHost/Render): бот-переходник, бот платных подписок, СБП через BigPay + Telegram Stars (`XTR`), а также Crypto Pay при наличии ключа. Автоматическая выдача приглашения и удаление после окончания подписки.

Команда запуска: `npm run bot:start` (или `node bot.js`). Переменные окружения перечислены в `.env.example`; токены хранятся только в настройках хостинга.

Bot: https://t.me/Secretroom2_app

Live (Render): https://secret-room-bot-qs4c.onrender.com — после merge в `main` нужен redeploy сервиса.

## UX оплаты (subscription bot)

Пошаговая навигация с кнопкой «Назад»:

1. `/start` — короткое приветствие и выбор тарифа (USD + ₽ на кнопках).
2. Выбор тарифа → способы оплаты: **рубли / СБП (BigPay)**, **Telegram Stars**, и **крипта (Crypto Pay)** при наличии `CRYPTO_PAY_API_TOKEN`.
3. Рубли → подменю BigPay: СБП напрямую, карта/Stripe, общий paylink.
4. После оплаты любого метода — общий `activateOrder` (одноразовый инвайт).

## Тарифы

| План | USD (Crypto Pay) | RUB (BigPay) | Stars (`XTR`) |
|------|------------------|--------------|---------------|
| 7 дней | $5 | 299 ₽ | 250 ⭐ |
| Месяц | $9 | 699 ₽ | 450 ⭐ |
| 3 месяца | $20 | 1799 ₽ | 1000 ⭐ |
| Навсегда | $35 | 2990 ₽ | 1750 ⭐ |

### Маппинг Stars (`XTR`)

Ориентир ≈ **$0.02 за 1 ⭐** (типичная цена пакетов Stars у Telegram): `xtr ≈ usd / 0.02`.

| План | USD | Расчёт | `xtr` в боте |
|------|-----|--------|--------------|
| week | 5 | 5 / 0.02 | 250 |
| month | 9 | 9 / 0.02 | 450 |
| quarter | 20 | 20 / 0.02 | 1000 |
| lifetime | 35 | 35 / 0.02 | 1750 |

Суммы заданы в `PLANS.*.xtr` в `bot.js`. При смене тарифов обновляйте и таблицу выше.

## Оплата

1. **Crypto Pay** — инвойс в USD, USDT и другие активы Crypto Bot.
2. **BigPay (RUB)** — подменю после выбора «Рубли» ([docs](https://bigpay.site/docs)):
   - **СБП напрямую** — `create_paylink` + `get_requisites` с `type: "sbp"`
   - **Карта (Stripe)** — `POST /api/v1/create_stripe_paylink` (нужен включённый Stripe у магазина)
   - **СБП и другие методы** — `POST /api/v1/create_paylink`; плательщик выбирает метод на `/pay/{external_id}`
3. **Telegram Stars (`XTR`)** — `sendInvoice` с `currency: "XTR"` и пустым `provider_token`, затем `pre_checkout_query` → `answerPreCheckoutQuery`, `successful_payment` → тот же `activateOrder`.

`get_requisites` `type`: `sbp` | `crypto` | `cryptobot` | `stripe`. Нативный C2C / SberPay на форме BigPay пока недоступен; карты — только через Stripe.

Статусы BigPay: `PENDING` → `CONFIRMED` → `COMPLETED`. Бот поллит `check_status` (как Crypto Pay) и принимает shop webhook; fulfilment общий. Stars не поллятся — активация только по `successful_payment`; неоплаченные Stars-ордера истекают через ~1 ч.

После успешной оплаты бот выдаёт одноразовый инвайт в канал.

### Telegram Stars / BotFather

Для приёма Stars отдельный platform provider token **не нужен** (`provider_token: ""`, валюта `XTR`).

Проверьте в [@BotFather](https://t.me/BotFather):

1. Бот может отправлять инвойсы (для цифровых товаров / Stars обычно достаточно обычного бота без отдельного Payments provider).
2. Если BotFather спрашивает про Payments / currency — для Stars выберите поток **Telegram Stars** / digital goods, **не** подключайте сторонний платежный провайдер ради `XTR`.
3. После деплоя протестируйте оплату минимальным тарифом в тестовом чате: должен прийти нативный Stars-invoice, затем доступ в канал.

## Secrets на хостинге

Обязательные:

- `GATEWAY_BOT_TOKEN`
- `SUBSCRIPTION_BOT_TOKEN`
- `CRYPTO_PAY_API_TOKEN` (необязателен; нужен только для криптооплаты)
- `PAID_CHANNEL_ID`

Для RUB / BigPay:

- `BIGPAY_API_TOKEN` — API-ключ магазина (`sk_live_...` / `sk_test_...`), заголовок `X-API-Key` (также поддерживается `Authorization: Bearer …`). Только из env, не коммитить.
- `BIGPAY_WEBHOOK_SECRET` — необязательный секрет в пути webhook (`/bigpay/webhook/<secret>`), чтобы чужие POST не принимались. Тот же путь укажите в кабинете BigPay → webhook магазина.
- `PUBLIC_BASE_URL` — публичный HTTPS origin (без слэша в конце), чтобы в логах подсказать полный URL webhook. Для Render: `https://secret-room-bot-qs4c.onrender.com`.

Для работы СБП обязательно добавьте `BIGPAY_API_TOKEN` и настройте webhook. Пример webhook URL для кабинета BigPay:

`https://<your-host>/bigpay/webhook/<BIGPAY_WEBHOOK_SECRET>`

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

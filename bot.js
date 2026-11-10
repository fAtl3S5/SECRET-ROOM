import http from "node:http";
import { unlinkSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import crypto from "node:crypto";

const required = ["GATEWAY_BOT_TOKEN", "SUBSCRIPTION_BOT_TOKEN", "PAID_CHANNEL_ID"];
for (const key of required) if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);

const GATEWAY_TOKEN = process.env.GATEWAY_BOT_TOKEN;
const SUBSCRIPTION_TOKEN = process.env.SUBSCRIPTION_BOT_TOKEN;
const CRYPTO_TOKEN = process.env.CRYPTO_PAY_API_TOKEN || "";
const CRYPTO_ENABLED = Boolean(CRYPTO_TOKEN);
const BIGPAY_TOKEN = process.env.BIGPAY_API_TOKEN || "";
const BIGPAY_WEBHOOK_SECRET = process.env.BIGPAY_WEBHOOK_SECRET || "";
const PAID_CHANNEL_ID = process.env.PAID_CHANNEL_ID;
const MAIN_CHANNEL_URL = process.env.MAIN_CHANNEL_URL || "https://t.me/+4H3FZze1XTdiMmJi";
const SAFE_CHANNEL_URL = process.env.SAFE_CHANNEL_URL || "https://t.me/blessedbabes";
const SUBSCRIPTION_BOT_URL = process.env.SUBSCRIPTION_BOT_URL || "https://t.me/srprivatee_bot?start=gateway";
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const WELCOME_GIF_URL = process.env.WELCOME_GIF_URL || "https://raw.githubusercontent.com/fAtl3S5/SECRET-ROOM/main/assets/secret-room-welcome.gif";
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = resolve(process.env.DATA_FILE || "./data/subscriptions.json");
const BIGPAY_API_BASE = "https://bigpay.site/api";
const BIGPAY_SITE = "https://bigpay.site";
const BIGPAY_ENABLED = Boolean(BIGPAY_TOKEN);

// xtr ≈ plan.usd / 0.02 (Telegram Stars pack ~$0.02/★). Documented in README.
const PLANS = {
  week: { title: "7 дней", usd: "5", rub: 299, xtr: 250, ms: 7 * 86400_000 },
  month: { title: "Месяц", usd: "9", rub: 699, xtr: 450, ms: 30 * 86400_000 },
  quarter: { title: "3 месяца", usd: "20", rub: 1799, xtr: 1000, ms: 90 * 86400_000 },
  lifetime: { title: "Навсегда", usd: "35", rub: 2990, xtr: 1750, ms: null },
};

const BACK_PLANS = { text: "« Назад", callback_data: "nav:plans" };

let state = { orders: {}, access: {} };
let writeQueue = Promise.resolve();
let lockHandle;

async function acquireProcessLock() {
  const lockPath = resolve(dirname(DATA_FILE), "secret-room-bot.lock");
  await mkdir(dirname(DATA_FILE), { recursive: true });
  try {
    lockHandle = await open(lockPath, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    try {
      const pid = Number((await readFile(lockPath, "utf8")).trim());
      process.kill(pid, 0);
      throw new Error(`Another SECRET ROOM process is already running (pid ${pid})`);
    } catch (checkError) {
      if (checkError?.code !== "ESRCH") throw checkError;
    }
    await unlink(lockPath);
    lockHandle = await open(lockPath, "wx");
  }
  await lockHandle.writeFile(String(process.pid));
  const release = async () => { try { await lockHandle.close(); await unlink(lockPath); } catch {} };
  process.once("exit", () => { try { unlinkSync(lockPath); } catch {} });
  process.once("SIGTERM", async () => { await release(); process.exit(0); });
  process.once("SIGINT", async () => { await release(); process.exit(0); });
}

async function loadState() {
  try {
    const parsed = JSON.parse(await readFile(DATA_FILE, "utf8"));
    state = { orders: parsed.orders || {}, access: parsed.access || {} };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await saveState();
  }
}

function saveState() {
  writeQueue = writeQueue.then(async () => {
    await mkdir(dirname(DATA_FILE), { recursive: true });
    const temporary = `${DATA_FILE}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temporary, DATA_FILE);
  });
  return writeQueue;
}

async function telegram(token, method, body = {}) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Telegram ${method}: ${result.description || response.status}`);
  return result.result;
}

async function cryptoPay(method, body = {}) {
  const response = await fetch(`https://pay.crypt.bot/api/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Crypto-Pay-API-Token": CRYPTO_TOKEN },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Crypto Pay ${method}: ${result.error?.name || response.status}`);
  return result.result;
}

async function bigPay(method, body = {}) {
  if (!BIGPAY_ENABLED) throw new Error("BigPay is not configured");
  const response = await fetch(`${BIGPAY_API_BASE}/v1/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-API-Key": BIGPAY_TOKEN },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.success === false) {
    const detail = result.message || result.errors || response.status;
    throw new Error(`BigPay ${method}: ${detail}`);
  }
  return result;
}

function bigPayPayUrl(paylink) {
  if (!paylink) throw new Error("BigPay paylink missing");
  if (/^https?:\/\//i.test(paylink)) return paylink;
  return `${BIGPAY_SITE}${paylink.startsWith("/") ? paylink : `/${paylink}`}`;
}

function bigPayWebhookPath() {
  return BIGPAY_WEBHOOK_SECRET
    ? `/bigpay/webhook/${encodeURIComponent(BIGPAY_WEBHOOK_SECRET)}`
    : "/bigpay/webhook";
}

function plansKeyboard() {
  return Object.entries(PLANS).map(([id, plan]) => [{
    text: plan.title,
    callback_data: `buy:${id}`,
  }]);
}

function paymentMethodsKeyboard(planId) {
  const rows = [];
  if (CRYPTO_ENABLED) rows.push([{ text: "Крипта", callback_data: `pay:crypto:${planId}` }]);
  if (BIGPAY_ENABLED) {
    rows.push([{ text: "Рубли / СБП", callback_data: `nav:rub:${planId}` }]);
  }
  rows.push([{ text: "Telegram Stars", callback_data: `pay:stars:${planId}` }]);
  rows.push([BACK_PLANS]);
  return rows;
}

function rubMethodsKeyboard(planId) {
  return [
    [{ text: "СБП", callback_data: `pay:sbp:${planId}` }],
    [{ text: "Карта", callback_data: `pay:stripe:${planId}` }],
    [{ text: "Другие методы", callback_data: `pay:bigpay:${planId}` }],
    [{ text: "« Назад", callback_data: `nav:pay:${planId}` }],
  ];
}

async function showMenu(chatId, text, keyboard, messageId) {
  const payload = {
    chat_id: chatId,
    text,
    reply_markup: { inline_keyboard: keyboard },
    link_preview_options: { is_disabled: true },
  };
  if (messageId) {
    try {
      await telegram(SUBSCRIPTION_TOKEN, "editMessageText", { ...payload, message_id: messageId });
      return;
    } catch (error) {
      const description = String(error.message || "");
      if (!/message is not modified/i.test(description)) {
        // Fall through to a new message if the old one cannot be edited.
      } else {
        return;
      }
    }
  }
  await telegram(SUBSCRIPTION_TOKEN, "sendMessage", payload);
}

async function sendGatewayMenu(chatId) {
  await telegram(GATEWAY_TOKEN, "sendMessage", {
    chat_id: chatId, text: "🔐 SECRET ROOM\n\nВыбери, куда перейти:", link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [
      [{ text: "🔐 Войти в канал", url: MAIN_CHANNEL_URL }],
      [{ text: "✨ Канал без 18+", url: SAFE_CHANNEL_URL }],
      [{ text: "🔒 PRIVATE КАНАЛ", url: SUBSCRIPTION_BOT_URL }],
    ] },
  });
}

async function sendPlans(chatId, messageId) {
  const priceLines = Object.values(PLANS).map(
    (plan) => `• ${plan.title} — $${plan.usd} / ${plan.rub} ₽`,
  );
  const text = [
    "🔐 SECRET ROOM",
    "",
    "Добро пожаловать! Выбери период подписки, чтобы получить доступ в платный канал.",
    "",
    ...priceLines,
    "",
    "После выбора периода предложим способ оплаты.",
  ].join("\n");
  if (!messageId) {
    await telegram(SUBSCRIPTION_TOKEN, "sendAnimation", {
      chat_id: chatId,
      animation: WELCOME_GIF_URL,
      caption: text,
      reply_markup: { inline_keyboard: plansKeyboard() },
    });
    return;
  }
  await showMenu(chatId, text, plansKeyboard(), messageId);
}

async function sendPaymentMethodChoice(chatId, planId, messageId) {
  const plan = PLANS[planId];
  if (!plan) throw new Error("Unknown plan");
  const text = [
    `🔐 SECRET ROOM · ${plan.title}`,
    "",
    "Выбери способ оплаты:",
  ].join("\n");
  await showMenu(chatId, text, paymentMethodsKeyboard(planId), messageId);
}

async function sendRubMethodChoice(chatId, planId, messageId) {
  const plan = PLANS[planId];
  if (!plan) throw new Error("Unknown plan");
  if (!BIGPAY_ENABLED) throw new Error("BigPay is not configured");
  const text = [
    `🔐 SECRET ROOM · ${plan.title}`,
    `Сумма: ${plan.rub} ₽`,
    "",
    "Выбери способ оплаты в рублях:",
  ].join("\n");
  await showMenu(chatId, text, rubMethodsKeyboard(planId), messageId);
}

async function createCryptoInvoice(userId, planId) {
  const plan = PLANS[planId];
  if (!plan) throw new Error("Unknown plan");
  const orderId = crypto.randomUUID();
  const invoice = await cryptoPay("createInvoice", {
    currency_type: "fiat", fiat: "USD", amount: plan.usd,
    accepted_assets: "USDT,TON,BTC,ETH,LTC,BNB,TRX,USDC",
    description: `SECRET ROOM · ${plan.title}`, payload: orderId,
    allow_anonymous: false, allow_comments: false, expires_in: 3600,
  });
  state.orders[orderId] = {
    id: orderId, provider: "crypto", invoiceId: invoice.invoice_id, userId, planId,
    amount: plan.usd, currency: "USD", status: "pending", createdAt: Date.now(),
  };
  await saveState();
  return invoice.bot_invoice_url;
}

async function createStarsInvoice(userId, planId) {
  const plan = PLANS[planId];
  if (!plan) throw new Error("Unknown plan");
  const orderId = crypto.randomUUID();
  state.orders[orderId] = {
    id: orderId,
    provider: "stars",
    userId,
    planId,
    amount: plan.xtr,
    currency: "XTR",
    status: "pending",
    createdAt: Date.now(),
  };
  await saveState();
  await telegram(SUBSCRIPTION_TOKEN, "sendInvoice", {
    chat_id: userId,
    title: `SECRET ROOM · ${plan.title}`,
    description: `Подписка SECRET ROOM (${plan.title}). После оплаты доступ придёт автоматически.`,
    payload: orderId,
    currency: "XTR",
    provider_token: "",
    prices: [{ label: plan.title, amount: plan.xtr }],
  });
  return orderId;
}

async function storeBigPayOrder({ orderId, payment, userId, planId, method }) {
  const plan = PLANS[planId];
  state.orders[orderId] = {
    id: orderId,
    provider: "bigpay",
    method,
    paymentId: payment.id,
    externalId: payment.external_id,
    userId,
    planId,
    amount: plan.rub,
    currency: "RUB",
    status: "pending",
    createdAt: Date.now(),
    expiresAt: payment.expires_at || null,
  };
  await saveState();
}

async function createBigPayInvoice(userId, planId, method = "paylink") {
  const plan = PLANS[planId];
  if (!plan) throw new Error("Unknown plan");
  const orderId = crypto.randomUUID();
  const body = {
    amount: plan.rub,
    currency: "RUB",
    description: `SECRET ROOM · ${plan.title}`,
    ttlMinutes: 60,
    metadata: { orderId, userId: String(userId), planId, method },
  };

  if (method === "stripe") {
    const payment = await bigPay("create_stripe_paylink", body);
    await storeBigPayOrder({ orderId, payment, userId, planId, method: "stripe" });
    return {
      url: payment.paylink || payment.requisites?.value || bigPayPayUrl(payment.paylink),
      button: "Оплатить картой",
      hint: "Оплата картой через Stripe Checkout.",
    };
  }

  const payment = await bigPay("create_paylink", body);
  await storeBigPayOrder({ orderId, payment, userId, planId, method: method === "sbp" ? "sbp" : "paylink" });

  if (method === "sbp") {
    // get_requisites returns PaymentResponseDto with requisites: { type, label, value }
    const detailed = await bigPay("get_requisites", { external_id: payment.external_id, type: "sbp" });
    const sbpValue = detailed?.requisites?.value || detailed?.value;
    if (sbpValue && /^https?:\/\//i.test(sbpValue)) {
      return {
        url: sbpValue,
        button: "Оплатить через СБП",
        hint: "Прямая оплата через СБП. После перевода доступ придёт автоматически.",
      };
    }
    // Fallback to chooser paylink if requisites are not a clickable URL.
    return {
      url: bigPayPayUrl(detailed?.paylink || payment.paylink),
      button: "Оплатить через СБП",
      hint: "Открой страницу оплаты и выбери СБП.",
    };
  }

  return {
    url: bigPayPayUrl(payment.paylink),
    button: "Оплатить в ₽",
    hint: "На странице BigPay доступны СБП и другие включённые для магазина методы (карта — через Stripe, если подключён).",
  };
}

async function activateOrder(order) {
  if (order.status !== "pending") return;
  order.status = "fulfilling";
  await saveState();
  try {
    const current = state.access[order.userId] || {};
    const plan = PLANS[order.planId];
    const lifetime = Boolean(current.lifetime) || plan.ms === null;
    const expiresAt = lifetime ? null : Math.max(Date.now(), current.expiresAt || 0) + plan.ms;
    const invite = await telegram(SUBSCRIPTION_TOKEN, "createChatInviteLink", {
      chat_id: PAID_CHANNEL_ID, name: `SR ${order.id.slice(0, 8)}`,
      expire_date: Math.floor(Date.now() / 1000) + 86400, member_limit: 1,
    });
    await telegram(SUBSCRIPTION_TOKEN, "sendMessage", {
      chat_id: order.userId, text: `✅ Оплата получена. Доступ в SECRET ROOM (${plan.title}):`,
      reply_markup: { inline_keyboard: [[{ text: "Войти в канал", url: invite.invite_link }]] },
    });
    state.access[order.userId] = { expiresAt, lifetime, status: "active", updatedAt: Date.now() };
    order.status = "fulfilled";
    order.fulfilledAt = Date.now();
  } catch (error) {
    order.status = "pending";
    console.error("Fulfilment failed:", error.message);
  }
  await saveState();
}

function findOrderByBigPayExternalId(externalId) {
  if (!externalId) return null;
  return Object.values(state.orders).find(
    (order) => order.provider === "bigpay" && order.externalId === externalId,
  ) || null;
}

async function verifyAndActivateBigPayOrder(order) {
  if (!order || order.status !== "pending" || order.provider !== "bigpay") return false;
  const status = await bigPay("check_status", { external_id: order.externalId });
  if (status.external_id && status.external_id !== order.externalId) return false;
  if (Number(status.amount) !== Number(order.amount)) {
    console.error("BigPay amount mismatch for order", order.id);
    return false;
  }
  if (String(status.currency || "RUB").toUpperCase() !== "RUB") {
    console.error("BigPay currency mismatch for order", order.id);
    return false;
  }
  if (status.status === "COMPLETED") {
    await activateOrder(order);
    return true;
  }
  if (["EXPIRED", "CANCELLED"].includes(status.status)) {
    order.status = status.status.toLowerCase();
    await saveState();
  }
  return false;
}

async function checkPayments() {
  for (const order of Object.values(state.orders).filter((item) => item.status === "pending")) {
    try {
      if (order.provider === "bigpay") {
        await verifyAndActivateBigPayOrder(order);
        continue;
      }
      if (order.provider === "stars") {
        // Stars fulfilment is driven by successful_payment; expire stale unpaid invoices.
        if (Date.now() - order.createdAt > 3600_000) {
          order.status = "expired";
          await saveState();
        }
        continue;
      }
      const result = await cryptoPay("getInvoices", { invoice_ids: String(order.invoiceId) });
      const invoice = result.items?.[0];
      if (invoice?.status === "paid" && invoice.payload === order.id && Number(invoice.amount) === Number(order.amount)) {
        await activateOrder(order);
      } else if (["expired", "cancelled"].includes(invoice?.status)) {
        order.status = invoice.status;
        await saveState();
      }
    } catch (error) {
      console.error("Invoice check failed:", error.message);
    }
  }
}

async function expireSubscriptions() {
  const now = Date.now();
  for (const [userId, access] of Object.entries(state.access)) {
    if (access.status !== "active" || access.lifetime || !access.expiresAt || access.expiresAt > now) continue;
    access.status = "expiring";
    await saveState();
    try {
      await telegram(SUBSCRIPTION_TOKEN, "banChatMember", { chat_id: PAID_CHANNEL_ID, user_id: Number(userId) });
      await telegram(SUBSCRIPTION_TOKEN, "unbanChatMember", { chat_id: PAID_CHANNEL_ID, user_id: Number(userId), only_if_banned: true });
      access.status = "expired";
      await telegram(SUBSCRIPTION_TOKEN, "sendMessage", { chat_id: Number(userId), text: "Срок подписки SECRET ROOM закончился. Для продления выбери новый тариф: /start" }).catch(() => {});
    } catch (error) {
      access.status = "active";
      console.error("Expiry failed:", error.message);
    }
    await saveState();
  }
}

async function handleGatewayUpdate(update) {
  const message = update.message;
  if (message?.chat?.type === "private" && /^\/start(?:@\w+)?(?:\s|$)/i.test(message.text || "")) await sendGatewayMenu(message.chat.id);
}

async function handleStarsPayment(message) {
  const payment = message.successful_payment;
  if (!payment || payment.currency !== "XTR") return;
  const order = state.orders[payment.invoice_payload];
  if (!order || order.provider !== "stars") {
    console.error("Stars payment for unknown order:", payment.invoice_payload);
    return;
  }
  if (Number(payment.total_amount) !== Number(order.amount)) {
    console.error("Stars amount mismatch for order", order.id);
    return;
  }
  if (Number(order.userId) !== Number(message.from.id)) {
    console.error("Stars payer mismatch for order", order.id);
    return;
  }
  order.telegramPaymentChargeId = payment.telegram_payment_charge_id || null;
  order.providerPaymentChargeId = payment.provider_payment_charge_id || null;
  await saveState();
  await activateOrder(order);
}

async function handlePreCheckoutQuery(query) {
  const order = state.orders[query.invoice_payload];
  const planOk = order
    && order.provider === "stars"
    && order.status === "pending"
    && Number(order.userId) === Number(query.from.id)
    && Number(order.amount) === Number(query.total_amount)
    && String(query.currency).toUpperCase() === "XTR";

  if (!planOk) {
    await telegram(SUBSCRIPTION_TOKEN, "answerPreCheckoutQuery", {
      pre_checkout_query_id: query.id,
      ok: false,
      error_message: "Счёт устарел или не найден. Начни заново: /start",
    });
    return;
  }

  await telegram(SUBSCRIPTION_TOKEN, "answerPreCheckoutQuery", {
    pre_checkout_query_id: query.id,
    ok: true,
  });
}

async function handleSubscriptionUpdate(update) {
  if (update.pre_checkout_query) {
    await handlePreCheckoutQuery(update.pre_checkout_query);
    return;
  }

  const message = update.message;
  if (message?.successful_payment) {
    await handleStarsPayment(message);
    return;
  }

  if (message?.chat?.type === "private" && /^\/start(?:@\w+)?(?:\s|$)/i.test(message.text || "")) {
    await sendPlans(message.chat.id);
    return;
  }

  const query = update.callback_query;
  if (!query?.data) return;

  const chatId = query.message?.chat?.id || query.from.id;
  const messageId = query.message?.message_id;

  if (query.data === "nav:plans") {
    await telegram(SUBSCRIPTION_TOKEN, "answerCallbackQuery", { callback_query_id: query.id });
    await sendPlans(chatId, messageId);
    return;
  }

  const navPayMatch = /^nav:pay:(week|month|quarter|lifetime)$/.exec(query.data);
  if (navPayMatch) {
    await telegram(SUBSCRIPTION_TOKEN, "answerCallbackQuery", { callback_query_id: query.id });
    await sendPaymentMethodChoice(chatId, navPayMatch[1], messageId);
    return;
  }

  const navRubMatch = /^nav:rub:(week|month|quarter|lifetime)$/.exec(query.data);
  if (navRubMatch) {
    try {
      await telegram(SUBSCRIPTION_TOKEN, "answerCallbackQuery", { callback_query_id: query.id });
      await sendRubMethodChoice(chatId, navRubMatch[1], messageId);
    } catch (error) {
      console.error("RUB menu failed:", error.message);
      await telegram(SUBSCRIPTION_TOKEN, "answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
      await telegram(SUBSCRIPTION_TOKEN, "sendMessage", {
        chat_id: chatId,
        text: "Оплата в рублях сейчас недоступна. Выбери другой способ.",
      });
    }
    return;
  }

  const buyMatch = /^buy:(week|month|quarter|lifetime)$/.exec(query.data);
  if (buyMatch) {
    try {
      await telegram(SUBSCRIPTION_TOKEN, "answerCallbackQuery", { callback_query_id: query.id });
      await sendPaymentMethodChoice(chatId, buyMatch[1], messageId);
    } catch (error) {
      console.error("Plan selection failed:", error.message);
      await telegram(SUBSCRIPTION_TOKEN, "answerCallbackQuery", { callback_query_id: query.id }).catch(() => {});
      await telegram(SUBSCRIPTION_TOKEN, "sendMessage", { chat_id: chatId, text: "Не удалось открыть оплату. Попробуй немного позже." });
    }
    return;
  }

  const payMatch = /^pay:(crypto|bigpay|sbp|stripe|stars):(week|month|quarter|lifetime)$/.exec(query.data);
  if (!payMatch) return;

  const [, provider, planId] = payMatch;
  await telegram(SUBSCRIPTION_TOKEN, "answerCallbackQuery", { callback_query_id: query.id, text: "Создаю счёт…" });
  try {
    if (provider === "stars") {
      await createStarsInvoice(query.from.id, planId);
      return;
    }

    if (provider === "crypto") {
      const url = await createCryptoInvoice(query.from.id, planId);
      await telegram(SUBSCRIPTION_TOKEN, "sendMessage", {
        chat_id: query.from.id,
        text: `SECRET ROOM · ${PLANS[planId].title}\nЦена: $${PLANS[planId].usd}. После оплаты доступ придёт автоматически.`,
        reply_markup: { inline_keyboard: [
          [{ text: "Оплатить криптовалютой", url }],
          [{ text: "« Назад", callback_data: `nav:pay:${planId}` }],
        ] },
      });
      return;
    }

    const method = provider === "bigpay" ? "paylink" : provider;
    const invoice = await createBigPayInvoice(query.from.id, planId, method);
    await telegram(SUBSCRIPTION_TOKEN, "sendMessage", {
      chat_id: query.from.id,
      text: [
        `SECRET ROOM · ${PLANS[planId].title}`,
        `Цена: ${PLANS[planId].rub} ₽.`,
        invoice.hint,
        "После успешной оплаты доступ придёт автоматически.",
      ].join("\n"),
      reply_markup: { inline_keyboard: [
        [{ text: invoice.button, url: invoice.url }],
        [{ text: "« Назад", callback_data: `nav:rub:${planId}` }],
      ] },
    });
  } catch (error) {
    console.error("Invoice creation failed:", error.message);
    const stripeHint = provider === "stripe"
      ? " Карта через Stripe доступна только если шлюз включён у магазина BigPay."
      : "";
    await telegram(SUBSCRIPTION_TOKEN, "sendMessage", {
      chat_id: query.from.id,
      text: `Не удалось создать счёт.${stripeHint} Попробуй другой способ или немного позже.`,
      reply_markup: { inline_keyboard: [[{ text: "« Назад", callback_data: `nav:pay:${planId}` }]] },
    });
  }
}

async function pollingLoop(token, handler, label) {
  let offset = 0;
  while (true) {
    try {
      const updates = await telegram(token, "getUpdates", {
        offset,
        timeout: 50,
        allowed_updates: ["message", "callback_query", "pre_checkout_query"],
      });
      for (const update of updates) {
        offset = update.update_id + 1;
        try { await handler(update); } catch (error) { console.error(`${label} update failed:`, error.message); }
      }
    } catch (error) {
      console.error(`${label} polling failed:`, error.message);
      await new Promise((done) => setTimeout(done, 5000));
    }
  }
}

function readRequestBody(request, limit = 1_000_000) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolveBody(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function extractBigPayExternalId(payload) {
  if (!payload || typeof payload !== "object") return null;
  return (
    payload.external_id
    || payload.externalId
    || payload.data?.external_id
    || payload.payment?.external_id
    || payload.payload?.external_id
    || null
  );
}

function extractBigPayStatus(payload) {
  if (!payload || typeof payload !== "object") return null;
  return payload.status || payload.data?.status || payload.payment?.status || null;
}

async function handleBigPayWebhook(request, response, pathSecret) {
  if (!BIGPAY_ENABLED) {
    response.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: "bigpay_disabled" }));
    return;
  }
  if (BIGPAY_WEBHOOK_SECRET) {
    if (!pathSecret || pathSecret !== BIGPAY_WEBHOOK_SECRET) {
      response.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
  }

  let payload = {};
  try {
    const raw = await readRequestBody(request);
    if (raw.length) payload = JSON.parse(raw.toString("utf8"));
  } catch {
    response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: "invalid_json" }));
    return;
  }

  const externalId = extractBigPayExternalId(payload);
  if (!externalId) {
    response.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: "missing_external_id" }));
    return;
  }

  const order = findOrderByBigPayExternalId(externalId);
  if (!order) {
    // Acknowledge unknown ids so BigPay does not retry forever for foreign events.
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, ignored: true }));
    return;
  }

  try {
    // Docs do not publish a webhook HMAC scheme; always re-check via Merchant API before fulfilment.
    const hint = extractBigPayStatus(payload);
    if (!hint || String(hint).toUpperCase() === "COMPLETED" || String(hint).toUpperCase() === "CONFIRMED") {
      await verifyAndActivateBigPayOrder(order);
    }
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true }));
  } catch (error) {
    console.error("BigPay webhook failed:", error.message);
    response.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false }));
  }
}

function createHttpServer() {
  return http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    const webhookBase = "/bigpay/webhook";

    if (request.method === "POST" && (url.pathname === webhookBase || url.pathname.startsWith(`${webhookBase}/`))) {
      const pathSecret = url.pathname === webhookBase
        ? ""
        : decodeURIComponent(url.pathname.slice(webhookBase.length + 1));
      await handleBigPayWebhook(request, response, pathSecret);
      return;
    }

    if (request.method === "GET" && url.pathname === "/health") {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        ok: true,
        service: "SECRET ROOM bot",
        bigpay: BIGPAY_ENABLED,
        webhookPath: BIGPAY_ENABLED ? bigPayWebhookPath() : null,
      }));
      return;
    }

    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: true, service: "SECRET ROOM bot" }));
  });
}

await acquireProcessLock();
await loadState();

createHttpServer().listen(PORT, "0.0.0.0", () => {
  console.log(`Health server listening on ${PORT}`);
  if (BIGPAY_ENABLED) {
    const path = bigPayWebhookPath();
    const hint = PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}${path}` : path;
    console.log(`BigPay enabled; set shop webhook URL in cabinet to: ${hint}`);
  } else {
    console.log("BigPay disabled (BIGPAY_API_TOKEN not set); crypto + Stars mode");
  }
});

Promise.all([
  telegram(GATEWAY_TOKEN, "deleteWebhook", { drop_pending_updates: false }),
  telegram(SUBSCRIPTION_TOKEN, "deleteWebhook", { drop_pending_updates: false }),
]).catch((error) => console.error("Webhook cleanup failed:", error.message));

setInterval(() => checkPayments().catch(console.error), 30_000);
setInterval(() => expireSubscriptions().catch(console.error), 60_000);
checkPayments().catch(console.error);
expireSubscriptions().catch(console.error);
pollingLoop(GATEWAY_TOKEN, handleGatewayUpdate, "gateway");
pollingLoop(SUBSCRIPTION_TOKEN, handleSubscriptionUpdate, "subscription");

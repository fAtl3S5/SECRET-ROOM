import http from "node:http";
import { unlinkSync } from "node:fs";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import crypto from "node:crypto";

const required = ["GATEWAY_BOT_TOKEN", "SUBSCRIPTION_BOT_TOKEN", "CRYPTO_PAY_API_TOKEN", "PAID_CHANNEL_ID"];
for (const key of required) if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);

const GATEWAY_TOKEN = process.env.GATEWAY_BOT_TOKEN;
const SUBSCRIPTION_TOKEN = process.env.SUBSCRIPTION_BOT_TOKEN;
const CRYPTO_TOKEN = process.env.CRYPTO_PAY_API_TOKEN;
const PAID_CHANNEL_ID = process.env.PAID_CHANNEL_ID;
const MAIN_CHANNEL_URL = process.env.MAIN_CHANNEL_URL || "https://t.me/+4H3FZze1XTdiMmJi";
const SAFE_CHANNEL_URL = process.env.SAFE_CHANNEL_URL || "https://t.me/blessedbabes";
const SUBSCRIPTION_BOT_URL = process.env.SUBSCRIPTION_BOT_URL || "https://t.me/srprivatee_bot?start=gateway";
const PORT = Number(process.env.PORT || 3000);
const DATA_FILE = resolve(process.env.DATA_FILE || "./data/subscriptions.json");

const PLANS = {
  week: { title: "7 дней", usd: "5", rub: 299, ms: 7 * 86400_000 },
  month: { title: "Месяц", usd: "9", rub: 699, ms: 30 * 86400_000 },
  quarter: { title: "3 месяца", usd: "20", rub: 1799, ms: 90 * 86400_000 },
  lifetime: { title: "Навсегда", usd: "35", rub: 2990, ms: null },
};

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
      await unlink(lockPath);
      lockHandle = await open(lockPath, "wx");
    }
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

async function sendPlans(chatId) {
  await telegram(SUBSCRIPTION_TOKEN, "sendMessage", {
    chat_id: chatId,
    text: "🔐 SECRET ROOM\n\nВыбери период подписки. Оплата через Crypto Pay — доступны USDT и другие криптовалюты.",
    reply_markup: { inline_keyboard: Object.entries(PLANS).map(([id, plan]) => [{
      text: `${plan.title} · $${plan.usd} / ${plan.rub} ₽`, callback_data: `buy:${id}`,
    }]) },
  });
}

async function createInvoice(userId, planId) {
  const plan = PLANS[planId];
  if (!plan) throw new Error("Unknown plan");
  const orderId = crypto.randomUUID();
  const invoice = await cryptoPay("createInvoice", {
    currency_type: "fiat", fiat: "USD", amount: plan.usd,
    accepted_assets: "USDT,TON,BTC,ETH,LTC,BNB,TRX,USDC",
    description: `SECRET ROOM · ${plan.title}`, payload: orderId,
    allow_anonymous: false, allow_comments: false, expires_in: 3600,
  });
  state.orders[orderId] = { id: orderId, invoiceId: invoice.invoice_id, userId, planId, amount: plan.usd, status: "pending", createdAt: Date.now() };
  await saveState();
  return invoice.bot_invoice_url;
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

async function checkPayments() {
  for (const order of Object.values(state.orders).filter((item) => item.status === "pending")) {
    try {
      const result = await cryptoPay("getInvoices", { invoice_ids: String(order.invoiceId) });
      const invoice = result.items?.[0];
      if (invoice?.status === "paid" && invoice.payload === order.id && Number(invoice.amount) === Number(order.amount)) await activateOrder(order);
      else if (["expired", "cancelled"].includes(invoice?.status)) { order.status = invoice.status; await saveState(); }
    } catch (error) { console.error("Invoice check failed:", error.message); }
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

async function handleSubscriptionUpdate(update) {
  const message = update.message;
  if (message?.chat?.type === "private" && /^\/start(?:@\w+)?(?:\s|$)/i.test(message.text || "")) { await sendPlans(message.chat.id); return; }
  const query = update.callback_query;
  const match = /^buy:(week|month|quarter|lifetime)$/.exec(query?.data || "");
  if (!match) return;
  await telegram(SUBSCRIPTION_TOKEN, "answerCallbackQuery", { callback_query_id: query.id, text: "Создаю счёт…" });
  try {
    const url = await createInvoice(query.from.id, match[1]);
    await telegram(SUBSCRIPTION_TOKEN, "sendMessage", {
      chat_id: query.from.id,
      text: `SECRET ROOM · ${PLANS[match[1]].title}\nЦена: $${PLANS[match[1]].usd}. После оплаты доступ придёт автоматически.`,
      reply_markup: { inline_keyboard: [[{ text: "Оплатить криптовалютой", url }]] },
    });
  } catch (error) {
    console.error("Invoice creation failed:", error.message);
    await telegram(SUBSCRIPTION_TOKEN, "sendMessage", { chat_id: query.from.id, text: "Не удалось создать счёт. Попробуй немного позже." });
  }
}

async function pollingLoop(token, handler, label) {
  let offset = 0;
  while (true) {
    try {
      const updates = await telegram(token, "getUpdates", { offset, timeout: 50, allowed_updates: ["message", "callback_query"] });
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

await acquireProcessLock();
await loadState();
await Promise.all([
  telegram(GATEWAY_TOKEN, "deleteWebhook", { drop_pending_updates: false }),
  telegram(SUBSCRIPTION_TOKEN, "deleteWebhook", { drop_pending_updates: false }),
]);

http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify({ ok: true, service: "SECRET ROOM bot" }));
}).listen(PORT, "0.0.0.0", () => console.log(`Health server listening on ${PORT}`));

setInterval(() => checkPayments().catch(console.error), 30_000);
setInterval(() => expireSubscriptions().catch(console.error), 60_000);
checkPayments().catch(console.error);
expireSubscriptions().catch(console.error);
pollingLoop(GATEWAY_TOKEN, handleGatewayUpdate, "gateway");
pollingLoop(SUBSCRIPTION_TOKEN, handleSubscriptionUpdate, "subscription");

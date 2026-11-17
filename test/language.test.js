import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

// Run the real update/payment handlers without starting a server or contacting providers.
const source = (await fs.readFile(new URL("../bot.js", import.meta.url), "utf8"))
  .replace(/^import .*;\r?\n/gm, "").split("await acquireProcessLock();")[0];
const start = (id, text = "/start") => ({ message: { chat: { id, type: "private" }, from: { id }, text } });
const click = (id, data) => ({ callback_query: { id: `query-${id}`, from: { id }, data, message: { message_id: 12, chat: { id, type: "private" } } } });

async function harness(t) {
  const dir = await fs.mkdtemp(join(tmpdir(), "sr-language-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  let fail = false;
  const context = vm.createContext({
    ...fs, dirname, resolve, crypto, console: { error() {} },
    process: { env: { GATEWAY_BOT_TOKEN: "gateway", SUBSCRIPTION_BOT_TOKEN: "subscription", PAID_CHANNEL_ID: "-1001", CRYPTO_PAY_API_TOKEN: "mock", BIGPAY_API_TOKEN: "mock", DATA_FILE: join(dir, "state.json") } },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      const method = url.split("/").at(-1);
      calls.push({ url, method, body });
      if (fail && (!url.includes("api.telegram.org") || method === "sendAnimation")) throw new Error("Simulated outage");
      const result = url.includes("api.telegram.org")
        ? { ok: true, result: { invite_link: "https://t.me/mock" } }
        : url.includes("pay.crypt.bot")
          ? { ok: true, result: { invoice_id: 1, bot_invoice_url: "https://t.me/invoice" } }
          : { id: 1, external_id: crypto.randomUUID(), paylink: "https://bigpay.site/pay/mock", requisites: { value: "https://bigpay.site/sbp/mock" } };
      return { ok: true, json: async () => result };
    },
  });
  vm.runInContext(source, context);
  const run = (code) => vm.runInContext(code, context);
  await run("loadState()");
  return { run, calls, last: () => calls.at(-1).body, gateway: (u) => context.handleGatewayUpdate(u), subscription: (u) => context.handleSubscriptionUpdate(u), fail: () => { fail = true; } };
}

test("language selection is shared, persistent, reversible, and isolated per user", async (t) => {
  const h = await harness(t);
  await h.gateway(start(11));
  assert.match(h.last().text, /Выбери/);
  assert.equal(h.last().reply_markup.inline_keyboard.at(-1)[0].callback_data, "lang:en");
  await h.gateway(click(11, "lang:en"));
  assert.match(h.last().text, /Choose where/);
  await h.run("loadState()");
  await h.subscription(start(11));
  assert.match(h.last().caption, /Welcome to the private channel/);
  assert.equal(h.last().reply_markup.inline_keyboard[0][0].text, "7 days");
  await h.gateway(start(22));
  assert.match(h.last().text, /Выбери/);
  await h.subscription(click(11, "lang:ru"));
  assert.match(h.last().caption, /Добро пожаловать/);
  await h.gateway(start(11));
  assert.match(h.last().text, /Выбери/);
  await h.gateway(start(11, "/language"));
  assert.equal(h.last().reply_markup.inline_keyboard[0][1].callback_data, "lang:en");
  await h.subscription(start(11, "/language"));
  assert.match(h.last().text, /Choose your language/);
  await h.subscription(click(11, "lang:de"));
  assert.equal(h.run("state.languages[11]"), "ru");
});

test("English menus, all payment providers, confirmation and expiry", async (t) => {
  const h = await harness(t);
  await h.subscription(click(11, "lang:en"));
  for (const data of ["buy:week", "nav:rub:week", "nav:pay:week", "nav:plans", "pay:crypto:week", "pay:sbp:week", "pay:stripe:week", "pay:bigpay:week", "pay:stars:week"]) {
    h.calls.length = 0;
    await h.subscription(click(11, data));
    assert.ok(h.calls.length > 1, data);
    for (const call of h.calls) {
      const content = JSON.stringify(call.body).replaceAll("🌐 Русский", "");
      assert.doesNotMatch(content, /[А-Яа-яЁё]/, data);
    }
  }
  const invoice = h.last();
  assert.equal(invoice.currency, "XTR");
  assert.equal(invoice.prices[0].amount, 250);
  await h.subscription({ pre_checkout_query: { id: "checkout", from: { id: 11 }, invoice_payload: invoice.payload, total_amount: 250, currency: "XTR" } });
  assert.equal(h.last().ok, true);
  await h.subscription({ message: { from: { id: 11 }, successful_payment: { currency: "XTR", invoice_payload: invoice.payload, total_amount: 250 } } });
  assert.match(h.last().text, /Payment received/);
  assert.equal(h.last().reply_markup.inline_keyboard[0][0].text, "Join the channel");
  await h.run("state.access[11].expiresAt = 1; expireSubscriptions()");
  assert.match(h.last().text, /subscription has expired/);
});

test("English errors and animation fallback, old state migration", async (t) => {
  const h = await harness(t);
  await h.run('writeFile(DATA_FILE, JSON.stringify({orders: {}, access: {22: {status: "active"}}}))');
  await h.run("loadState()");
  assert.equal(h.run("state.access[22].status"), "active");
  assert.equal(h.run('localize(11, "ru", "en")'), "ru");
  await h.subscription(click(11, "lang:en"));
  h.fail();
  await h.subscription(start(11));
  assert.match(h.last().text, /Welcome/);
  for (const provider of ["crypto", "stripe", "sbp", "bigpay"]) {
    await h.subscription(click(11, `pay:${provider}:month`));
    assert.match(h.last().text, /Could not create invoice/);
    assert.doesNotMatch(h.last().text, /[А-Яа-яЁё]/);
  }
  await h.subscription({ pre_checkout_query: { id: "invalid", from: { id: 11 }, invoice_payload: "missing" } });
  assert.equal(h.last().ok, false);
  assert.match(h.last().error_message, /expired or could not be found/);
});

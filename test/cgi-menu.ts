/**
 * تست منوی خرید CGI با ربات واقعی (تلگرام شبیه‌سازی‌شده) + OpenStack شبیه‌ساز:
 * لوکیشن (پرچم) ← سرویس (قیمت‌ها) ← سیستم‌عامل ← شبکه ← پرداخت ← ساخت و تحویل. اجرا: npm run test:cgimenu
 */
import assert from "node:assert/strict";
import { startMockOS } from "./mock-openstack";

async function main() {
  const os = await startMockOS();
  Object.assign(process.env, {
    BOT_TOKEN: "123456:TESTTOKEN", ADMIN_IDS: "900",
    CGI_AUTH_URL: `http://127.0.0.1:${os.port}/identity/v3`, CGI_APP_CRED_ID: "CID", CGI_APP_CRED_SECRET: "CSEC",
    CGI_REGION: "r1", CGI_SECURITY_GROUP: "allow_all", CGI_TIMEOUT_MS: "3000", CGI_BUILD_TIMEOUT_MS: "3000", CGI_POLL_MS: "50",
  });
  const { getBot } = await import("../src/bot/index");
  const { query, queryOne, pool } = await import("../src/core");
  const DC = await import("../src/datacenters");
  const { seedCatalog } = await import("../src/datacenters/cgi/seed");

  await query("TRUNCATE services, locations, os_templates, settings RESTART IDENTITY CASCADE");
  await query("DELETE FROM plans");
  await query("DELETE FROM users WHERE id IN (900, 901)");
  await query("INSERT INTO users (id, balance) VALUES (901, 5000000)");
  await query("DELETE FROM bandwidth_prices");
  await seedCatalog({ paris: "r1", nl: "r1", lv: "r2", fi: "r1" });

  const bot = getBot();
  const out: { method: string; payload: any }[] = [];
  const all: { method: string; payload: any }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    out.push({ method, payload });
    all.push({ method, payload });
    if (method === "getMe") return { ok: true, result: { id: 1, is_bot: true, first_name: "t", username: "tbot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } } as any;
    if (method === "sendMessage" || method.startsWith("edit")) return { ok: true, result: { message_id: 1, chat: { id: 901 }, date: 0 } } as any;
    return { ok: true, result: true } as any;
  });
  await bot.init();

  let n = 1;
  const user = { id: 901, is_bot: false, first_name: "u", username: "usr" };
  const cb = async (data: string) => {
    out.length = 0;
    await bot.handleUpdate({ update_id: n++, callback_query: { id: String(n), from: user, chat_instance: "x", data, message: { message_id: 5, date: 0, chat: { id: 901, type: "private" }, text: "m" } } } as any);
  };
  const admin = { id: 900, is_bot: false, first_name: "a", username: "adm" };
  const say = async (from: typeof user, textMsg: string) => {
    out.length = 0;
    const len = textMsg.indexOf(" ") > 0 ? textMsg.indexOf(" ") : textMsg.length;
    await bot.handleUpdate({ update_id: n++, message: { message_id: n, date: 0, chat: { id: from.id, type: "private" }, from, text: textMsg, entities: [{ offset: 0, length: len, type: "bot_command" }] } } as any);
  };
  const last = () => [...out].reverse().find((o) => o.method === "sendMessage" || o.method === "editMessageText");
  const text = () => (last()?.payload.text as string) ?? "";
  const rows = (): { text: string; callback_data: string }[][] => last()?.payload.reply_markup?.inline_keyboard ?? [];
  const labels = () => rows().map((r) => r.map((b) => b.text));
  const toast = () => out.find((o) => o.method === "answerCallbackQuery")?.payload.text as string | undefined;
  const planId = async (name: string) => (await queryOne<{ id: number }>("SELECT id FROM plans WHERE datacenter='cgi' AND name=$1", [name]))!.id;

  const tests: [string, () => Promise<void>][] = [];
  const t = (name: string, f: () => Promise<void>) => tests.push([name, f]);

  t("بین‌الملل ← CGI: لوکیشن‌ها با پرچم، دو‌تا‌دوتا: پاریس/هلند، لاتویا/فنلاند", async () => {
    await cb("intl");
    assert.ok(labels().flat().includes("CGI"));
    await cb("dc:cgi");
    assert.equal(text(), "لوکیشن سرور خود را انتخاب کنید:");
    assert.deepEqual(labels().slice(0, 2), [["🇫🇷 پاریس", "🇳🇱 هلند"], ["🇱🇻 لاتویا", "🇫🇮 فنلاند"]]);
  });

  t("پلن بدون قیمتِ پهنای باند در منوی خرید نمایش داده نمی‌شود (تا ادمین قیمت بدهد)", async () => {
    await cb("cg:l:cgi_fi");
    assert.equal(toast(), "هنوز سرویسی برای این لوکیشن فعال نشده است.");
    await say(admin, "/bw");
    assert.ok(text().includes("هنوز هیچ قیمتی ثبت نشده"));
  });

  t("ادمین با /setbw قیمت می‌دهد (ماهانه = ساعتی × ۷۲۰) و /bw لیست می‌کند؛ غیرادمین رد می‌شود", async () => {
    await say(user, "/setbw hostvds-1 1/2/3");
    assert.equal(out.length, 0); // کاربر عادی: بی‌پاسخ
    await say(admin, "/setbw hostvds-1 2782/3154/3898");
    assert.ok(text().includes("ثبت شد"));
    await say(admin, "/setbw hostvds-2 1000 5000"); // فقط یک سرعت
    await say(admin, "/setbw nope 1000 5000");
    assert.ok(text().includes("پیدا نشد"));
    await say(admin, "/setbw hostvds-1 777 5000");
    assert.ok(text().includes("سرعت باید"));
    const rows = await query<any>("SELECT p.name, b.mbps, b.hourly_price, b.monthly_price FROM bandwidth_prices b JOIN plans p ON p.id=b.plan_id ORDER BY p.name, b.mbps");
    assert.deepEqual(rows.map((r) => [r.name, r.mbps, r.hourly_price, r.monthly_price]), [
      ["hostvds-1", 100, 2782, 2003040], ["hostvds-1", 1000, 3154, 2270880], ["hostvds-1", 10000, 3898, 2806560],
      ["hostvds-2", 1000, 5000, 3600000],
    ]);
    await say(admin, "/bw");
    assert.ok(text().includes("hostvds-1") && text().includes("2,003,040"));
  });

  t("سرویس‌ها: خط قیمت هر پلن و دکمه‌ی نام پلن (به ترتیب قیمت)", async () => {
    await cb("cg:l:cgi_fi");
    assert.ok(text().startsWith("سرویس مورد نظر خود را انتخاب نمایید :"));
    assert.ok(text().includes("💸 PRICE : 1386 hourly 997,920 monthly hostvds-1"));
    assert.ok(text().includes("💸 PRICE : 2400 hourly 1,728,000 monthly hostvds-2"));
    assert.ok(!text().includes("highload")); // غیرفعال
    assert.deepEqual(labels().slice(0, 2), [["hostvds-1"], ["hostvds-2"]]);
  });

  t("پلنی که فلورش در ریجن نیست در آن لوکیشن نمایش داده نمی‌شود (لاتویا = r2: فقط hostvds-1)", async () => {
    await cb("cg:l:cgi_lv");
    assert.ok(text().includes("hostvds-1") && !text().includes("hostvds-2"));
  });

  t("سیستم‌عامل: UBUNTU 20 تنها، UBUNTU 22 و 24 کنار هم", async () => {
    await cb(`cg:p:cgi_fi:${await planId("hostvds-1")}`);
    assert.equal(text(), "سیستم عامل سرور خود را انتخاب نمایید ؛");
    assert.deepEqual(labels().slice(0, 2), [["UBUNTU 20"], ["UBUNTU 22", "UBUNTU 24"]]);
  });

  t("شبکه: لیست رنج‌ها در متن و دکمه‌ی INTERNET-xx برای هر شبکه", async () => {
    await cb(`cg:o:cgi_fi:${await planId("hostvds-1")}:cg_ubuntu_2404`);
    assert.ok(text().startsWith("شبکه مورد نظر خود را انتخاب نمایید :\n\nلیست آیپی رنج شبکه ها :"));
    assert.ok(text().includes("INTERNET-01 : <code>13.140.80.0/24</code>") && text().includes("INTERNET-02 : <code>13.140.85.0/24</code>"));
    assert.deepEqual(labels()[0], ["INTERNET-01", "INTERNET-02"]);
  });

  t("پهناباند: متن و قیمت‌های تمام‌شده دقیقاً مطابق درخواست؛ دکمه‌ها 100MB / 1000MB / 10000MB", async () => {
    await cb(`cg:n:cgi_fi:${await planId("hostvds-1")}:cg_ubuntu_2404:Internet-02`);
    assert.equal(
      text(),
      "مقدار پهناباند مورد نظر را انتخاب نمایید :\n\n" +
        "⚠️   توجه نمایید پهنا باند قیمت جدا دارد و قیمت نمایش داده شده در لیست زیر قیمت تموم شده سرور شما میباشد !\n\n" +
        "پهناباند 100 مگابیتی نامحدود : 2,003,040\nساعتی : 2782\n\n" +
        "پهناباند 1000 مگابیتی نامحدود : 2,270,880\nساعتی : 3154\n\n" +
        "پهناباند 10000 مگابیتی نامحدود : 2,806,560\nساعتی : 3898",
    );
    assert.deepEqual(labels().slice(0, 3), [["100MB"], ["1000MB"], ["10000MB"]]);
  });

  t("ورودی نامعتبر (شبکه/پلن/لوکیشن/پهنای باند دستکاری‌شده) پذیرفته نمی‌شود و پولی کسر نمی‌شود", async () => {
    const pid = await planId("hostvds-1");
    const bal = (await queryOne<any>("SELECT balance FROM users WHERE id=901"))!.balance;
    await cb(`cg:n:cgi_fi:${pid}:cg_ubuntu_2404:Internet-99`);
    assert.equal(toast(), "انتخاب نامعتبر");
    await cb(`cg:b:h:cgi_fi:${pid}:cg_ubuntu_2404:Internet-99:1000`);
    assert.equal(toast(), "انتخاب نامعتبر");
    await cb(`cg:l:cgi_nope`);
    assert.equal(toast(), "لوکیشن نامعتبر");
    await cb(`cg:b:h:cgi_fi:${await planId("highload-1")}:cg_ubuntu_2404:Internet-01:1000`); // پلن غیرفعال/بدون قیمت
    assert.equal(toast(), "انتخاب نامعتبر");
    await cb(`cg:w:cgi_fi:${pid}:cg_ubuntu_2404:Internet-01:500`); // سرعتی که تعریف نشده
    assert.equal(toast(), "انتخاب نامعتبر");
    await cb(`cg:b:h:cgi_fi:${pid}:cg_ubuntu_2404:Internet-01:500`);
    assert.ok(toast()?.includes("پهنای باند"));
    await cb(`cg:b:h:cgi_fi:${await planId("hostvds-2")}:cg_ubuntu_2404:Internet-01:100`); // hostvds-2 فقط سرعت ۱۰۰۰ دارد
    assert.ok(toast()?.includes("پهنای باند"));
    assert.equal((await queryOne<any>("SELECT count(*)::int AS n FROM services"))!.n, 0);
    assert.equal((await queryOne<any>("SELECT balance FROM users WHERE id=901"))!.balance, bal);
  });

  t("خلاصه و نوع پرداخت: قیمت‌های همان پهنای باند (۱۰۰۰ مگابیت)", async () => {
    await cb(`cg:w:cgi_fi:${await planId("hostvds-1")}:cg_ubuntu_2404:Internet-02:1000`);
    assert.ok(text().includes("🌐 شبکه: INTERNET-02") && text().includes("UBUNTU 24") && text().includes("🇫🇮 فنلاند"));
    assert.ok(text().includes("📶 پهناباند: 1000 مگابیت نامحدود"));
    assert.ok(text().includes("<b>3154</b> تومان در ساعت") && text().includes("2,270,880"));
    const flat = rows().flat().map((b) => b.callback_data);
    assert.ok(flat.some((d) => d?.startsWith("cg:b:h:")) && flat.some((d) => d?.startsWith("cg:b:m:")));
    assert.ok(rows().flat().some((b) => b.text.includes("3154")));
  });

  t("callback_data هیچ‌جا از ۶۴ بایت تلگرام بیشتر نمی‌شود (حتی بدترین حالت نام‌ها)", async () => {
    const worst = (p: string) => `${p}:cgi_paris:99999:cg_ubuntu_2404:${"x".repeat(16)}:10000`;
    for (const p of ["cg:w", "cg:b:m", "cg:n"]) assert.ok(Buffer.byteLength(worst(p)) <= 64, p);
  });

  let bought = 0;
  t("خرید ساعتی ۱۰۰۰ مگابیت: هزینه‌ی کسرشده = قیمت همان پهنای باند (نه قیمت پایه‌ی پلن)", async () => {
    const pid = await planId("hostvds-1");
    await cb(`cg:b:h:cgi_fi:${pid}:cg_ubuntu_2404:Internet-02:1000`);
    assert.ok(text().includes("در حال ساخت") && text().includes("3,154"));
    assert.equal((await queryOne<any>("SELECT balance FROM users WHERE id=901"))!.balance, 5000000 - 3154);
    let row: any;
    for (let i = 0; i < 100; i++) { // ساخت در پس‌زمینه
      row = await queryOne<any>("SELECT id, status, ip, external_id, dc_meta, login_pass, hourly_price FROM services ORDER BY id DESC LIMIT 1");
      if (row.status !== "provisioning") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    bought = row.id;
    assert.equal(row.status, "active");
    assert.equal(row.hourly_price, 3154); // قیمت سرویس = قیمت همان سرعت
    assert.equal(row.dc_meta.network, "Internet-02");
    assert.equal(row.dc_meta.region, "r1");
    assert.equal(row.dc_meta.bandwidth, 1000);
    assert.ok(row.ip.startsWith("13.140.85."));
    // پیام تحویل: IP، یوزر، پسورد و مشخصات سرور
    const delivered = all.filter((o) => o.method === "sendMessage" && o.payload.chat_id === 901).map((o) => String(o.payload.text)).join("\n");
    for (const must of [row.ip, "root", row.login_pass, "hostvds-1", "1 vCPU", "10GB", "🇫🇮 فنلاند", "UBUNTU 24", "INTERNET-02", "پهناباند: 1000 مگابیت نامحدود"]) {
      assert.ok(delivered.includes(must), `پیام تحویل «${must}» ندارد`);
    }
  });

  t("صورتحساب ساعتی با قیمت همان پهنای باند کسر می‌شود (۳۱۵۴، نه ۱۳۸۶)", async () => {
    const before = (await queryOne<any>("SELECT balance FROM users WHERE id=901"))!.balance;
    await query("UPDATE services SET last_billed_at = now() - interval '61 minutes' WHERE id=$1", [bought]);
    const { runBilling } = await import("../src/lib/billing");
    await runBilling(bot.api as any);
    assert.equal(before - (await queryOne<any>("SELECT balance FROM users WHERE id=901"))!.balance, 3154);
  });

  t("خرید ماهانه ۱۰۰۰۰ مگابیت: کسر یک روز از قیمت ماهانه‌ی همان پهنای باند", async () => {
    const pid = await planId("hostvds-1");
    const before = (await queryOne<any>("SELECT balance FROM users WHERE id=901"))!.balance;
    await cb(`cg:b:m:cgi_fi:${pid}:cg_ubuntu_2204:Internet-01:10000`);
    assert.equal(before - (await queryOne<any>("SELECT balance FROM users WHERE id=901"))!.balance, Math.round(2806560 / 30));
    const row = (await queryOne<any>("SELECT hourly_price, monthly_price, billing_mode, dc_meta FROM services ORDER BY id DESC LIMIT 1"))!;
    assert.deepEqual([row.hourly_price, row.monthly_price, row.billing_mode, row.dc_meta.bandwidth], [3898, 2806560, "monthly", 10000]);
    for (let i = 0; i < 100; i++) { // ساخت تمام شود تا تست بعدی تداخل نکند
      if ((await queryOne<any>("SELECT status FROM services ORDER BY id DESC LIMIT 1"))!.status !== "provisioning") break;
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  t("خاموش شدن CGI از پنل ادمین: دکمه‌ی CGI دیگر قابل ورود نیست", async () => {
    await DC.setEnabled("cgi", false);
    await cb("intl");
    assert.ok(!labels().flat().includes("CGI"));
    await cb("dc:cgi");
    assert.equal(toast(), "دیتاسنتر نامعتبر");
    await DC.setEnabled("cgi", true);
  });

  let failed = 0;
  for (const [name, f] of tests) {
    try { await f(); console.log("✔", name); } catch (e) { failed++; console.log("✘", name, "\n ", e instanceof Error ? e.stack?.split("\n").slice(0, 5).join("\n  ") : e); }
  }
  await os.close();
  await pool.end();
  if (failed) { console.log(`\n${failed} TEST(S) FAILED`); process.exit(1); }
  console.log("\nCGI MENU TESTS PASSED");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

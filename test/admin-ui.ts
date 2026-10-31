/**
 * تست رابط پنل ادمین: ربات واقعی با آپدیت‌های ساختگی تلگرام و دیتابیس واقعی (API تلگرام شبیه‌سازی می‌شود)
 * اجرا: DATABASE_URL=postgresql://... npm run test:admin
 */
import assert from "node:assert/strict";
import { startMock } from "./mock-virtualizor";

async function main() {
  const mock = await startMock();
  Object.assign(process.env, {
    BOT_TOKEN: "123456:TESTTOKEN",
    ADMIN_IDS: "900",
    VIRT_URL: `http://127.0.0.1:${mock.port}`,
    VIRT_API_KEY: "KEY",
    VIRT_API_PASS: "PASS",
    VIRT_USER_DOMAIN: "mizban.com",
    VIRT_TIMEOUT_MS: "3000",
  });
  const { getBot } = await import("../src/bot/index");
  const { query, queryOne, pool } = await import("../src/lib/db");
  const { getSettings } = await import("../src/lib/settings");

  await query("TRUNCATE services, locations, os_templates, settings RESTART IDENTITY CASCADE");
  await query("DELETE FROM plans");
  await query("DELETE FROM users WHERE id IN (900, 901)");

  const bot = getBot();
  const out: { method: string; payload: any }[] = [];
  bot.api.config.use(async (_prev, method, payload) => {
    out.push({ method, payload });
    if (method === "getMe") return { ok: true, result: { id: 1, is_bot: true, first_name: "t", username: "tbot", can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } } as any;
    if (method === "sendMessage" || method.startsWith("edit")) return { ok: true, result: { message_id: 1, chat: { id: 900 }, date: 0 } } as any;
    return { ok: true, result: true } as any;
  });
  await bot.init();

  let uidn = 1;
  const as = (id: number) => ({ id, is_bot: false, first_name: "a", username: id === 900 ? "adm" : "usr" });
  const cb = async (data: string, from = 900) => {
    out.length = 0;
    await bot.handleUpdate({
      update_id: uidn++,
      callback_query: { id: String(uidn), from: as(from), chat_instance: "x", data, message: { message_id: 5, date: 0, chat: { id: from, type: "private" }, text: "m" } },
    } as any);
  };
  const say = async (text: string, from = 900) => {
    out.length = 0;
    await bot.handleUpdate({
      update_id: uidn++,
      message: {
        message_id: uidn, date: 0, chat: { id: from, type: "private" }, from: as(from), text,
        ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0].length }] } : {}),
      },
    } as any);
  };
  const lastText = () => {
    const m = [...out].reverse().find((o) => o.method === "sendMessage" || o.method === "editMessageText");
    return (m?.payload.text as string) ?? "";
  };
  const lastKb = () => {
    const m = [...out].reverse().find((o) => o.method === "sendMessage" || o.method === "editMessageText");
    return JSON.stringify(m?.payload.reply_markup ?? {});
  };
  const toast = () => out.find((o) => o.method === "answerCallbackQuery")?.payload.text as string | undefined;

  // ادمین وارد می‌شود؛ منوی اصلی دکمه‌ها را دارد
  await say("/start");
  await cb("admin");
  assert.match(lastKb(), /adm:cat/);
  assert.match(lastKb(), /adm:set/);
  await cb("adm:cat");
  for (const k of ["adm:pl", "adm:lc", "adm:os", "adm:set", "adm:iss", "adm:virt"]) assert.match(lastKb(), new RegExp(k));
  console.log("✔ catalog menu has all sections");

  // غیرادمین دسترسی ندارد
  await say("/start", 901);
  await cb("adm:pl", 901);
  assert.match(toast() ?? "", /دسترسی/);
  assert.equal((await queryOne("SELECT 1 FROM plans LIMIT 1")), null);
  console.log("✔ non-admin blocked");

  // ── پلن جدید (ویزارد ۷ مرحله‌ای)
  await cb("adm:pn");
  for (const v of ["irvps1", "1", "1", "10", "1750", "770000", "1"]) await say(v);
  let p = (await queryOne<any>("SELECT * FROM plans WHERE name='irvps1'"))!;
  assert.deepEqual([p.cpu, p.ram_gb, p.ram_mb, p.disk_gb, p.hourly_price, p.monthly_price, p.virt_plid, p.active], [1, 1, 1024, 10, 1750, 770000, 1, true]);
  assert.match(lastText(), /irvps1/);
  console.log("✔ new plan wizard");

  // اعتبارسنجی ورودی
  await cb(`adm:pe:${p.id}:h`);
  await say("abc");
  assert.match(lastText(), /عدد/);
  assert.equal((await queryOne<any>("SELECT hourly_price FROM plans WHERE id=$1", [p.id]))!.hourly_price, 1750);
  // اعداد فارسی هم پذیرفته می‌شود
  await say("۲۱۵۰");
  assert.equal((await queryOne<any>("SELECT hourly_price FROM plans WHERE id=$1", [p.id]))!.hourly_price, 2150);
  // ویرایش نام، رم، ماهانه (۰ = حذف)
  await cb(`adm:pe:${p.id}:n`); await say("irvps2");
  await cb(`adm:pe:${p.id}:r`); await say("2");
  await cb(`adm:pe:${p.id}:m`); await say("0");
  p = (await queryOne<any>("SELECT * FROM plans WHERE id=$1", [p.id]))!;
  assert.deepEqual([p.name, p.ram_gb, p.ram_mb, p.monthly_price], ["irvps2", 2, 2048, null]);
  console.log("✔ edit plan fields (validation, persian digits, 0 clears)");

  // فعال/غیرفعال
  await cb(`adm:pt:${p.id}`);
  assert.equal((await queryOne<any>("SELECT active FROM plans WHERE id=$1", [p.id]))!.active, false);
  await cb(`adm:pt:${p.id}`);
  assert.equal((await queryOne<any>("SELECT active FROM plans WHERE id=$1", [p.id]))!.active, true);
  // قیمت صفر ← غیرفعال و اجازه‌ی فعال‌سازی ندارد
  await cb(`adm:pe:${p.id}:h`); await say("0");
  assert.equal((await queryOne<any>("SELECT active FROM plans WHERE id=$1", [p.id]))!.active, false);
  await cb(`adm:pt:${p.id}`);
  assert.match(toast() ?? "", /قیمت/);
  console.log("✔ toggle active / zero price blocks activation");

  // import از Virtualizor (فقط kvm، بدون تکرار)
  await cb("adm:pimp");
  assert.equal((await query("SELECT 1 FROM plans WHERE virt_plid=5")).length, 1);
  await cb("adm:pimp");
  assert.equal((await query("SELECT 1 FROM plans WHERE virt_plid=5")).length, 1);
  console.log("✔ import plans from panel");

  // حذف پلن: بدون سرویس ← حذف کامل ؛ با سرویس ← فقط غیرفعال
  const imp = (await queryOne<any>("SELECT id FROM plans WHERE virt_plid=5"))!;
  await cb(`adm:pd:${imp.id}`);
  assert.match(lastKb(), /adm:pdy/);
  await cb(`adm:pdy:${imp.id}`);
  assert.equal((await query("SELECT 1 FROM plans WHERE id=$1", [imp.id])).length, 0);
  await query("INSERT INTO users (id) VALUES (901) ON CONFLICT DO NOTHING");
  await query("INSERT INTO services (user_id, plan_id, hourly_price, location, os, status) VALUES (901,$1,1,'x','y','active')", [p.id]);
  await cb(`adm:pdy:${p.id}`);
  assert.equal((await queryOne<any>("SELECT active FROM plans WHERE id=$1", [p.id]))!.active, false, "kept but deactivated");
  console.log("✔ delete plan (hard if unused, soft if used)");

  // ── لوکیشن
  await cb("adm:ln");
  assert.match(lastText(), /localhost/); // لیست Nodeهای پنل
  await say("0");
  await say("🇮🇷 ایران");
  let loc = (await queryOne<any>("SELECT * FROM locations"))!;
  assert.deepEqual([loc.key, loc.title, loc.serid, loc.active], ["l0", "🇮🇷 ایران", 0, true]);
  await cb("adm:le:l0:t"); await say("ایران - تهران");
  await cb("adm:le:l0:s"); await say("1");
  loc = (await queryOne<any>("SELECT * FROM locations WHERE key='l0'"))!;
  assert.deepEqual([loc.title, loc.serid], ["ایران - تهران", 1]);
  await cb("adm:lt:l0");
  assert.equal((await queryOne<any>("SELECT active FROM locations WHERE key='l0'"))!.active, false);
  await cb("adm:lt:l0");
  console.log("✔ locations add/edit/toggle");

  // ── سیستم‌عامل از لیست پنل
  await cb("adm:on");
  await say("ubuntu");
  assert.match(lastKb(), /adm:oa:0/);
  await cb("adm:oa:0");
  const os = (await queryOne<any>("SELECT * FROM os_templates"))!;
  assert.deepEqual([os.key, os.osid, os.active], ["o11", 11, true]);
  await cb("adm:oe:o11:n"); await say("Ubuntu 22.04");
  await cb("adm:oe:o11:i"); await say("100001");
  const os2 = (await queryOne<any>("SELECT * FROM os_templates WHERE key='o11'"))!;
  assert.deepEqual([os2.name, os2.osid], ["Ubuntu 22.04", 100001]);
  console.log("✔ OS pick from panel + edit");

  // ── تنظیمات
  await cb("adm:set");
  assert.match(lastText(), /شماره کارت/);
  await cb("adm:se:0"); await say("6037-9999-1111-2222");
  await cb("adm:se:1"); await say("Mehdi Z");
  await cb("adm:se:2"); await say("tetasupport");
  await cb("adm:se:3"); await say("۱۵۰۰۰۰");
  await cb("adm:se:4"); await say("180000");
  await cb("adm:se:5"); await say("12");
  const S = await getSettings();
  assert.deepEqual([S.cardNumber, S.cardOwner, S.support, S.minTopup, S.minBalanceToBuy, S.refPercent], ["6037-9999-1111-2222", "Mehdi Z", "@tetasupport", 150000, 180000, 12]);
  await cb("adm:se:5"); await say("150"); // خارج از محدوده
  assert.match(lastText(), /۰ تا ۹۹/);
  assert.equal((await getSettings()).refPercent, 12);
  console.log("✔ settings editable and used by bot");

  // تنظیمات واقعاً در رفتار ربات اثر دارند (کارت در شارژ، پشتیبانی)
  await say("/start", 901);
  await cb("support", 901);
  assert.match(lastText(), /@tetasupport/);
  await cb("topup", 901);
  assert.match(lastText(), /150,000/);
  await say("200000", 901);
  assert.match(lastText(), /6037-9999-1111-2222/);
  console.log("✔ bot messages use DB settings");

  // دستورهای قدیمی هم هنوز کار می‌کنند
  await say("/setplan 1|legacy|2|4|30|900|5000|3".replace("1|legacy", `${p.id}|legacy`));
  const lg = (await queryOne<any>("SELECT * FROM plans WHERE id=$1", [p.id]))!;
  assert.deepEqual([lg.name, lg.cpu, lg.ram_gb, lg.hourly_price, lg.monthly_price, lg.virt_plid, lg.active], ["legacy", 2, 4, 900, 5000, 3, true]);
  await say(`/setprice ${p.id} 0`);
  assert.equal((await queryOne<any>("SELECT active FROM plans WHERE id=$1", [p.id]))!.active, false);
  await say(`/setprice ${p.id} 1200`);
  assert.equal((await queryOne<any>("SELECT active, hourly_price FROM plans WHERE id=$1", [p.id]))!.hourly_price, 1200);
  console.log("✔ legacy /setplan and /setprice");

  // ── گزارش‌های مشکل
  await cb("adm:iss");
  assert.match(lastText(), /موردی وجود ندارد/);

  // انصراف از یک ورودی
  await cb("adm:pn");
  await cb("adm:cx:adm:pl");
  assert.equal((await queryOne<any>("SELECT state FROM users WHERE id=900"))!.state, null);
  console.log("✔ cancel clears state");

  await mock.close();
  await pool.end();
  console.log("\nADMIN UI TESTS PASSED");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { config } from "@/lib/config";
import { query, queryOne } from "@/lib/db";
import { importPanelPlans } from "@/lib/provider";
import { getSettings, resetSetting, setSetting } from "@/lib/settings";
import type { SettingKey } from "@/lib/settings";
import { getState, setState } from "@/lib/state";
import { discover, isConfigured } from "@/lib/virtualizor";
import { alert, esc, fmt, normalizeDigits, ramLabel, show, uid } from "../helpers";

/**
 * مدیریت فروش از داخل پنل ادمین (بدون دستور):
 *   پلن‌ها · لوکیشن‌ها · سیستم‌عامل‌ها · تنظیمات ربات · گزارش‌های مشکل دوره تست
 * ورودی‌های متنی با state های `cat_*` گرفته می‌شود.
 */

const isAdmin = (ctx: BotContext) => !!ctx.from && config.admins.includes(ctx.from.id);
const cancelKb = (back = "adm:cat") => new InlineKeyboard().text("❌ انصراف", `adm:cx:${back}`);
const num = (s: string) => Number(normalizeDigits(s.trim()));
const isInt = (s: string, max = 1e12) => /^\d+$/.test(normalizeDigits(s.trim())) && num(s) <= max;

// ───────────────────────── منوی اصلی ─────────────────────────
const CAT_TEXT = "🛍 <b>مدیریت فروش و کاتالوگ</b>\n\nیکی از بخش‌ها را انتخاب کنید:";
const catKb = () =>
  new InlineKeyboard()
    .text("🖥 پلن‌ها", "adm:pl")
    .text("📍 لوکیشن‌ها", "adm:lc")
    .row()
    .text("💿 سیستم‌عامل‌ها", "adm:os")
    .text("⚙️ تنظیمات ربات", "adm:set")
    .row()
    .text("⚠️ گزارش‌های مشکل (تست)", "adm:iss")
    .row()
    .text("🔌 وضعیت Virtualizor", "adm:virt")
    .row()
    .text("🔙 پنل مدیریت", "admin");

// ───────────────────────── پلن‌ها ─────────────────────────
interface PlanRow {
  id: number;
  name: string;
  cpu: number;
  ram_gb: number;
  ram_mb: number | null;
  disk_gb: number;
  hourly_price: number;
  monthly_price: number | null;
  active: boolean;
  virt_plid: number | null;
}

const PLAN_FIELDS: Record<string, { label: string; sql: string; kind: "text" | "int" }> = {
  n: { label: "نام پلن", sql: "name", kind: "text" },
  c: { label: "تعداد CPU", sql: "cpu", kind: "int" },
  r: { label: "رم (گیگابایت)", sql: "ram_gb", kind: "int" },
  d: { label: "دیسک (گیگابایت)", sql: "disk_gb", kind: "int" },
  h: { label: "قیمت ساعتی (تومان)", sql: "hourly_price", kind: "int" },
  m: { label: "قیمت ماهانه (تومان؛ ۰ = بدون ماهانه)", sql: "monthly_price", kind: "int" },
  p: { label: "شناسه Plan در Virtualizor (۰ = ندارد)", sql: "virt_plid", kind: "int" },
};

const getPlan = (id: number) => queryOne<PlanRow>("SELECT * FROM plans WHERE id=$1", [id]);

function planView(p: PlanRow) {
  const text =
    `🖥 <b>پلن #${p.id} — ${esc(p.name)}</b>\n` +
    `وضعیت: ${p.active ? "🟢 فعال (قابل فروش)" : "⚪️ غیرفعال"}\n\n` +
    `⚙️ CPU: ${p.cpu || "—"} | RAM: ${ramLabel(p)} | دیسک: ${p.disk_gb || "—"}GB\n` +
    `⏰ ساعتی: ${fmt(p.hourly_price)} تومان\n` +
    `🗓 ماهانه: ${p.monthly_price ? fmt(p.monthly_price) + " تومان" : "—"}\n` +
    `🔗 plid (Virtualizor): ${p.virt_plid ?? "—"}`;
  const id = p.id;
  const kb = new InlineKeyboard()
    .text("✏️ نام", `adm:pe:${id}:n`)
    .text("✏️ CPU", `adm:pe:${id}:c`)
    .text("✏️ RAM", `adm:pe:${id}:r`)
    .row()
    .text("✏️ دیسک", `adm:pe:${id}:d`)
    .text("✏️ ساعتی", `adm:pe:${id}:h`)
    .text("✏️ ماهانه", `adm:pe:${id}:m`)
    .row()
    .text("✏️ plid", `adm:pe:${id}:p`)
    .text(p.active ? "⚪️ غیرفعال کن" : "🟢 فعال کن", `adm:pt:${id}`)
    .row()
    .text("🗑 حذف پلن", `adm:pd:${id}`)
    .row()
    .text("⬅️ لیست پلن‌ها", "adm:pl");
  return { text, kb };
}

async function planList() {
  const rows = await query<PlanRow>("SELECT * FROM plans ORDER BY id");
  const kb = new InlineKeyboard();
  for (const p of rows) {
    kb.text(`${p.active ? "🟢" : "⚪️"} ${p.name} | ${fmt(p.hourly_price)}${p.monthly_price ? " | " + fmt(p.monthly_price) : ""}`, `adm:pl:${p.id}`).row();
  }
  kb.text("➕ پلن جدید", "adm:pn").row().text("⬇️ وارد کردن پلن‌ها از Virtualizor", "adm:pimp").row().text("⬅️ بازگشت", "adm:cat");
  return {
    text:
      "🖥 <b>پلن‌ها</b>\n\n🟢 = قابل فروش | ⚪️ = غیرفعال\nقالب هر دکمه: نام | قیمت ساعتی | قیمت ماهانه\n\nبرای ویرایش یا حذف روی پلن بزنید." +
      (rows.length ? "" : "\n\n<i>هنوز پلنی نیست. «وارد کردن از Virtualizor» یا «پلن جدید» را بزنید.</i>"),
    kb,
  };
}

const NEW_PLAN_STEPS: { key: string; ask: string; kind: "text" | "int" }[] = [
  { key: "name", ask: "نام پلن را بفرستید (مثلاً irvps1):", kind: "text" },
  { key: "cpu", ask: "تعداد CPU (عدد):", kind: "int" },
  { key: "ram", ask: "رم به گیگابایت (عدد):", kind: "int" },
  { key: "disk", ask: "دیسک به گیگابایت (عدد):", kind: "int" },
  { key: "hourly", ask: "قیمت ساعتی به تومان:", kind: "int" },
  { key: "monthly", ask: "قیمت ماهانه به تومان (۰ = بدون پرداخت ماهانه):", kind: "int" },
  { key: "plid", ask: "شناسه Plan در Virtualizor (عدد از ۱ تا ۴ و ...؛ ۰ = ندارد):", kind: "int" },
];

// ───────────────────────── لوکیشن‌ها ─────────────────────────
interface LocRow {
  key: string;
  title: string;
  serid: number;
  active: boolean;
}
const getLoc = (key: string) => queryOne<LocRow>("SELECT * FROM locations WHERE key=$1", [key]);

function locView(l: LocRow) {
  const text =
    `📍 <b>لوکیشن — ${esc(l.title)}</b>\nوضعیت: ${l.active ? "🟢 فعال" : "⚪️ غیرفعال"}\n\n` +
    `🔑 کلید: <code>${esc(l.key)}</code>\n🖥 serid (Node در Virtualizor): ${l.serid}`;
  const kb = new InlineKeyboard()
    .text("✏️ عنوان", `adm:le:${l.key}:t`)
    .text("✏️ serid", `adm:le:${l.key}:s`)
    .row()
    .text(l.active ? "⚪️ غیرفعال کن" : "🟢 فعال کن", `adm:lt:${l.key}`)
    .text("🗑 حذف", `adm:ld:${l.key}`)
    .row()
    .text("⬅️ لیست لوکیشن‌ها", "adm:lc");
  return { text, kb };
}

async function locList() {
  const rows = await query<LocRow>("SELECT * FROM locations ORDER BY key");
  const kb = new InlineKeyboard();
  for (const l of rows) kb.text(`${l.active ? "🟢" : "⚪️"} ${l.title} (serid ${l.serid})`, `adm:lc:${l.key}`).row();
  kb.text("➕ لوکیشن جدید", "adm:ln").row().text("⬅️ بازگشت", "adm:cat");
  return { text: "📍 <b>لوکیشن‌ها</b>\n\nبرای ویرایش یا حذف روی لوکیشن بزنید." + (rows.length ? "" : "\n\n<i>هنوز لوکیشنی نیست.</i>"), kb };
}

// ───────────────────────── سیستم‌عامل‌ها ─────────────────────────
interface OsRow {
  key: string;
  name: string;
  osid: number;
  active: boolean;
}
const getOs = (key: string) => queryOne<OsRow>("SELECT * FROM os_templates WHERE key=$1", [key]);

function osView(o: OsRow) {
  const text =
    `💿 <b>سیستم‌عامل — ${esc(o.name)}</b>\nوضعیت: ${o.active ? "🟢 فعال" : "⚪️ غیرفعال"}\n\n` +
    `🔑 کلید: <code>${esc(o.key)}</code>\n🆔 osid (OS Template در Virtualizor): ${o.osid}`;
  const kb = new InlineKeyboard()
    .text("✏️ نام نمایشی", `adm:oe:${o.key}:n`)
    .text("✏️ osid", `adm:oe:${o.key}:i`)
    .row()
    .text(o.active ? "⚪️ غیرفعال کن" : "🟢 فعال کن", `adm:ot:${o.key}`)
    .text("🗑 حذف", `adm:od:${o.key}`)
    .row()
    .text("⬅️ لیست سیستم‌عامل‌ها", "adm:os");
  return { text, kb };
}

async function osList() {
  const rows = await query<OsRow>("SELECT * FROM os_templates ORDER BY name");
  const kb = new InlineKeyboard();
  for (const o of rows) kb.text(`${o.active ? "🟢" : "⚪️"} ${o.name} (osid ${o.osid})`, `adm:os:${o.key}`).row();
  kb.text("➕ افزودن از لیست Virtualizor", "adm:on").row().text("⬅️ بازگشت", "adm:cat");
  return { text: "💿 <b>سیستم‌عامل‌ها</b>\n\nبرای ویرایش یا حذف روی مورد بزنید." + (rows.length ? "" : "\n\n<i>هنوز سیستم‌عاملی نیست.</i>"), kb };
}

// ───────────────────────── تنظیمات ربات ─────────────────────────
const SETTINGS: { key: SettingKey; label: string; kind: "text" | "int" | "support" | "card" | "percent" }[] = [
  { key: "card_number", label: "شماره کارت", kind: "card" },
  { key: "card_owner", label: "نام صاحب کارت", kind: "text" },
  { key: "support", label: "یوزرنیم پشتیبانی", kind: "support" },
  { key: "min_topup", label: "حداقل شارژ (تومان)", kind: "int" },
  { key: "min_balance_to_buy", label: "حداقل موجودی برای خرید (تومان)", kind: "int" },
  { key: "ref_percent", label: "درصد پورسانت دعوت (٪)", kind: "percent" },
];

async function settingsView() {
  const S = await getSettings();
  const vals: Record<SettingKey, string> = {
    card_number: S.cardNumber,
    card_owner: S.cardOwner,
    support: S.support,
    min_topup: fmt(S.minTopup),
    min_balance_to_buy: fmt(S.minBalanceToBuy),
    ref_percent: String(S.refPercent),
  };
  const kb = new InlineKeyboard();
  let text = "⚙️ <b>تنظیمات ربات</b>\n\n";
  SETTINGS.forEach((s, i) => {
    text += `• ${s.label}: <code>${esc(vals[s.key])}</code>\n`;
    kb.text(`✏️ ${s.label}`, `adm:se:${i}`).row();
  });
  kb.text("⬅️ بازگشت", "adm:cat");
  return { text, kb };
}

// ───────────────────────── ثبت هندلرها ─────────────────────────
export function registerAdminCatalog(bot: Bot<BotContext>) {
  const adm = bot.filter(isAdmin);

  const ask = async (ctx: BotContext, state: string, data: Record<string, unknown>, text: string, back = "adm:cat") => {
    await setState(uid(ctx), state, data);
    await show(ctx, text, cancelKb(back));
  };
  const replyView = (ctx: BotContext, v: { text: string; kb: InlineKeyboard }) =>
    ctx.reply(v.text, { parse_mode: "HTML", reply_markup: v.kb });

  adm.callbackQuery("adm:cat", async (ctx) => {
    await setState(uid(ctx), null);
    await show(ctx, CAT_TEXT, catKb());
  });

  // انصراف از هر ورودی: adm:cx:<مقصد>
  adm.callbackQuery(/^adm:cx:([\w:]+)$/, async (ctx) => {
    await setState(uid(ctx), null);
    await show(ctx, CAT_TEXT, catKb(), "لغو شد");
  });

  // ── پلن‌ها ──
  adm.callbackQuery("adm:pl", async (ctx) => {
    await setState(uid(ctx), null);
    const v = await planList();
    await show(ctx, v.text, v.kb);
  });

  adm.callbackQuery(/^adm:pl:(\d+)$/, async (ctx) => {
    const p = await getPlan(Number(ctx.match[1]));
    if (!p) return alert(ctx, "پلن پیدا نشد");
    const v = planView(p);
    await show(ctx, v.text, v.kb);
  });

  adm.callbackQuery(/^adm:pe:(\d+):([ncrdhmp])$/, async (ctx) => {
    const [, id, f] = ctx.match;
    const p = await getPlan(Number(id));
    if (!p) return alert(ctx, "پلن پیدا نشد");
    await ask(ctx, "cat_pe", { id: Number(id), f }, `✏️ <b>${PLAN_FIELDS[f].label}</b> را بفرستید:`, `adm:pl:${id}`);
  });

  adm.callbackQuery(/^adm:pt:(\d+)$/, async (ctx) => {
    const p = await getPlan(Number(ctx.match[1]));
    if (!p) return alert(ctx, "پلن پیدا نشد");
    if (!p.active && p.hourly_price <= 0) return alert(ctx, "اول قیمت ساعتی را تعیین کنید.");
    await query("UPDATE plans SET active = NOT active WHERE id=$1", [p.id]);
    const v = planView((await getPlan(p.id))!);
    await show(ctx, v.text, v.kb, "✅ انجام شد");
  });

  adm.callbackQuery(/^adm:pd:(\d+)$/, async (ctx) => {
    const p = await getPlan(Number(ctx.match[1]));
    if (!p) return alert(ctx, "پلن پیدا نشد");
    await show(
      ctx,
      `🗑 پلن <b>${esc(p.name)}</b> حذف شود؟\n\nاگر قبلاً سرویسی با این پلن ساخته شده باشد، فقط غیرفعال می‌شود (سرویس‌های فعلی دست‌نخورده می‌مانند).`,
      new InlineKeyboard().text("✅ بله، حذف کن", `adm:pdy:${p.id}`).text("❌ خیر", `adm:pl:${p.id}`),
    );
  });

  adm.callbackQuery(/^adm:pdy:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const used = await queryOne("SELECT 1 FROM services WHERE plan_id=$1 LIMIT 1", [id]);
    if (used) await query("UPDATE plans SET active=FALSE WHERE id=$1", [id]);
    else await query("DELETE FROM plans WHERE id=$1", [id]);
    const v = await planList();
    await show(ctx, v.text, v.kb, used ? "غیرفعال شد (سرویس‌هایی با این پلن وجود دارد)" : "حذف شد");
  });

  adm.callbackQuery("adm:pn", async (ctx) => {
    await ask(ctx, "cat_pn", { step: 0, v: {} }, `➕ <b>پلن جدید</b> (۱/${NEW_PLAN_STEPS.length})\n\n${NEW_PLAN_STEPS[0].ask}`, "adm:pl");
  });

  adm.callbackQuery("adm:pimp", async (ctx) => {
    if (!isConfigured()) return alert(ctx, "اتصال Virtualizor تنظیم نشده است.");
    await ctx.answerCallbackQuery({ text: "⏳ در حال خواندن از پنل…" });
    try {
      const r = await importPanelPlans();
      const v = await planList();
      await ctx.editMessageText(
        `✅ ${r.filter((x) => x.created).length} پلن جدید از ${r.length} پلن پنل وارد شد.\nبرای هر پلن‌ِ ⚪️ قیمت بدهید تا فعال شود.\n\n` + v.text,
        { parse_mode: "HTML", reply_markup: v.kb },
      );
    } catch (e) {
      await ctx.reply("❌ " + (e instanceof Error ? e.message : "خطا"));
    }
  });

  // ── لوکیشن‌ها ──
  adm.callbackQuery("adm:lc", async (ctx) => {
    await setState(uid(ctx), null);
    const v = await locList();
    await show(ctx, v.text, v.kb);
  });

  adm.callbackQuery(/^adm:lc:(\w+)$/, async (ctx) => {
    const l = await getLoc(ctx.match[1]);
    if (!l) return alert(ctx, "پیدا نشد");
    const v = locView(l);
    await show(ctx, v.text, v.kb);
  });

  adm.callbackQuery(/^adm:le:(\w+):([ts])$/, async (ctx) => {
    const [, key, f] = ctx.match;
    if (!(await getLoc(key))) return alert(ctx, "پیدا نشد");
    await ask(ctx, "cat_le", { key, f }, f === "t" ? "✏️ عنوان جدید را بفرستید (مثلاً 🇮🇷 ایران):" : "✏️ شناسه serid جدید را بفرستید (عدد):", `adm:lc:${key}`);
  });

  adm.callbackQuery(/^adm:lt:(\w+)$/, async (ctx) => {
    await query("UPDATE locations SET active = NOT active WHERE key=$1", [ctx.match[1]]);
    const l = await getLoc(ctx.match[1]);
    if (!l) return alert(ctx, "پیدا نشد");
    const v = locView(l);
    await show(ctx, v.text, v.kb, "✅ انجام شد");
  });

  adm.callbackQuery(/^adm:ld:(\w+)$/, async (ctx) => {
    const l = await getLoc(ctx.match[1]);
    if (!l) return alert(ctx, "پیدا نشد");
    await show(ctx, `🗑 لوکیشن <b>${esc(l.title)}</b> حذف شود؟`, new InlineKeyboard().text("✅ بله", `adm:ldy:${l.key}`).text("❌ خیر", `adm:lc:${l.key}`));
  });

  adm.callbackQuery(/^adm:ldy:(\w+)$/, async (ctx) => {
    await query("DELETE FROM locations WHERE key=$1", [ctx.match[1]]);
    const v = await locList();
    await show(ctx, v.text, v.kb, "حذف شد");
  });

  adm.callbackQuery("adm:ln", async (ctx) => {
    let hint = "";
    if (isConfigured()) {
      const d = await discover().catch(() => null);
      if (d?.ok && d.servers.length) hint = "\n\nNode های پنل:\n" + d.servers.map((s) => `• serid <b>${s.id}</b> — ${esc(s.name)}`).join("\n");
    }
    await ask(ctx, "cat_ln", { step: "serid" }, `➕ <b>لوکیشن جدید</b>\n\nشناسه <b>serid</b> (Node در Virtualizor) را بفرستید. برای Node اصلی معمولاً 0 است.${hint}`, "adm:lc");
  });

  // ── سیستم‌عامل‌ها ──
  adm.callbackQuery("adm:os", async (ctx) => {
    await setState(uid(ctx), null);
    const v = await osList();
    await show(ctx, v.text, v.kb);
  });

  adm.callbackQuery(/^adm:os:(\w+)$/, async (ctx) => {
    const o = await getOs(ctx.match[1]);
    if (!o) return alert(ctx, "پیدا نشد");
    const v = osView(o);
    await show(ctx, v.text, v.kb);
  });

  adm.callbackQuery(/^adm:oe:(\w+):([ni])$/, async (ctx) => {
    const [, key, f] = ctx.match;
    if (!(await getOs(key))) return alert(ctx, "پیدا نشد");
    await ask(ctx, "cat_oe", { key, f }, f === "n" ? "✏️ نام نمایشی جدید را بفرستید (مثلاً Ubuntu 24.04):" : "✏️ osid جدید را بفرستید (عدد):", `adm:os:${key}`);
  });

  adm.callbackQuery(/^adm:ot:(\w+)$/, async (ctx) => {
    await query("UPDATE os_templates SET active = NOT active WHERE key=$1", [ctx.match[1]]);
    const o = await getOs(ctx.match[1]);
    if (!o) return alert(ctx, "پیدا نشد");
    const v = osView(o);
    await show(ctx, v.text, v.kb, "✅ انجام شد");
  });

  adm.callbackQuery(/^adm:od:(\w+)$/, async (ctx) => {
    const o = await getOs(ctx.match[1]);
    if (!o) return alert(ctx, "پیدا نشد");
    await show(ctx, `🗑 سیستم‌عامل <b>${esc(o.name)}</b> حذف شود؟`, new InlineKeyboard().text("✅ بله", `adm:ody:${o.key}`).text("❌ خیر", `adm:os:${o.key}`));
  });

  adm.callbackQuery(/^adm:ody:(\w+)$/, async (ctx) => {
    await query("DELETE FROM os_templates WHERE key=$1", [ctx.match[1]]);
    const v = await osList();
    await show(ctx, v.text, v.kb, "حذف شد");
  });

  adm.callbackQuery("adm:on", async (ctx) => {
    if (!isConfigured()) return alert(ctx, "اتصال Virtualizor تنظیم نشده است.");
    await ask(
      ctx,
      "cat_os_q",
      {},
      `💿 <b>افزودن سیستم‌عامل</b>\n\nبخشی از نام را بفرستید تا از پنل جستجو شود (مثلاً <code>ubuntu</code> یا <code>debian</code>).\nفقط Templateهای نوع <b>${esc(config.virt.type)}</b> نمایش داده می‌شوند؛ برای همه‌ی انواع بنویسید <code>all</code>.`,
      "adm:os",
    );
  });

  // انتخاب یکی از نتایج جستجو (اندیس از state)
  adm.callbackQuery(/^adm:oa:(\d+)$/, async (ctx) => {
    const st = await getState(uid(ctx));
    const list = (st.data?.list as { id: number; name: string }[] | undefined) ?? [];
    const item = list[Number(ctx.match[1])];
    if (st.state !== "cat_os_pick" || !item) return alert(ctx, "جلسه منقضی شده؛ دوباره جستجو کنید.");
    const key = `o${item.id}`;
    await query(
      `INSERT INTO os_templates (key,name,osid) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET osid=EXCLUDED.osid, active=TRUE`,
      [key, item.name, item.id],
    );
    await setState(uid(ctx), null);
    const v = osView((await getOs(key))!);
    await show(ctx, v.text + "\n\n💡 با «✏️ نام نمایشی» می‌توانید اسم را زیباتر کنید (مثلاً Ubuntu 24.04).", v.kb, "✅ اضافه شد");
  });

  // ── تنظیمات ربات ──
  adm.callbackQuery("adm:set", async (ctx) => {
    await setState(uid(ctx), null);
    const v = await settingsView();
    await show(ctx, v.text, v.kb);
  });

  adm.callbackQuery(/^adm:se:(\d+)$/, async (ctx) => {
    const s = SETTINGS[Number(ctx.match[1])];
    if (!s) return alert(ctx, "نامعتبر");
    await ask(ctx, "cat_se", { i: Number(ctx.match[1]) }, `✏️ مقدار جدید «${s.label}» را بفرستید:`, "adm:set");
  });

  // ── گزارش‌های مشکل دوره تست ──
  adm.callbackQuery("adm:iss", async (ctx) => {
    const rows = await query<{ id: number; plan_name: string; user_id: number; ip: string | null }>(
      `SELECT s.id, p.name AS plan_name, s.user_id, s.ip FROM services s JOIN plans p ON p.id=s.plan_id
        WHERE s.status='active' AND s.billing_mode='monthly' AND s.trial AND s.trial_issue ORDER BY s.id`,
    );
    const kb = new InlineKeyboard();
    for (const r of rows) kb.text(`#${r.id} ${r.plan_name} — ${r.ip ?? ""}`, `adm:is:${r.id}`).row();
    kb.text("⬅️ بازگشت", "adm:cat");
    await show(ctx, "⚠️ <b>گزارش‌های مشکل در دوره تست</b>\n\n" + (rows.length ? "روی هر مورد بزنید:" : "موردی وجود ندارد 👌"), kb);
  });

  adm.callbackQuery(/^adm:is:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const s = await queryOne<{ plan_name: string; user_id: number; ip: string | null; initial_charge: number }>(
      `SELECT p.name AS plan_name, s.user_id, s.ip, s.initial_charge FROM services s JOIN plans p ON p.id=s.plan_id
        WHERE s.id=$1 AND s.status='active' AND s.trial AND s.trial_issue`,
      [id],
    );
    if (!s) return alert(ctx, "این مورد دیگر باز نیست.");
    await show(
      ctx,
      `⚠️ <b>سرور #${id}</b> — ${esc(s.plan_name)}\n🌐 IP: <code>${esc(s.ip)}</code>\n👤 کاربر: <code>${s.user_id}</code>\n💵 هزینه روز تست: ${fmt(s.initial_charge)} تومان\n\nتصمیم شما؟`,
      new InlineKeyboard()
        .text("✅ مشکل رفع شد؛ ادامه تمدید", `adm:tok:${id}`)
        .row()
        .text("🗑 لغو و بازگشت وجه", `adm:tx:${id}`)
        .row()
        .text("⬅️ بازگشت", "adm:iss"),
    );
  });

  // ── ورودی‌های متنی ──
  adm.on("message:text", async (ctx, next) => {
    const st = await getState(uid(ctx));
    if (!st.state?.startsWith("cat_")) return next();
    if (ctx.message.text.startsWith("/")) return next();
    const raw = ctx.message.text.trim();
    const d = st.data ?? {};

    // ویرایش یک فیلد پلن
    if (st.state === "cat_pe") {
      const id = Number(d.id);
      const f = PLAN_FIELDS[String(d.f)];
      if (!f) return;
      if (f.kind === "text") {
        if (!raw || raw.length > 40) return void ctx.reply("❌ نام باید ۱ تا ۴۰ کاراکتر باشد.", { reply_markup: cancelKb(`adm:pl:${id}`) });
      } else if (!isInt(raw)) {
        return void ctx.reply("❌ فقط عدد صحیح (۰ یا بیشتر) بفرستید.", { reply_markup: cancelKb(`adm:pl:${id}`) });
      }
      const v: string | number | null = f.kind === "text" ? raw : num(raw);
      if (d.f === "r") await query("UPDATE plans SET ram_gb=$2::int, ram_mb=$2::int*1024 WHERE id=$1", [id, v]);
      else if (d.f === "m" || d.f === "p") await query(`UPDATE plans SET ${f.sql}=$2 WHERE id=$1`, [id, v === 0 ? null : v]);
      else if (d.f === "h") await query("UPDATE plans SET hourly_price=$2::bigint, active = active AND $2::bigint > 0 WHERE id=$1", [id, v]);
      else await query(`UPDATE plans SET ${f.sql}=$2 WHERE id=$1`, [id, v]);
      await setState(uid(ctx), null);
      const p = await getPlan(id);
      return void (p ? replyView(ctx, planView(p)) : ctx.reply("پلن پیدا نشد."));
    }

    // ساخت پلن جدید (مرحله‌به‌مرحله)
    if (st.state === "cat_pn") {
      const step = Number(d.step);
      const vals = (d.v as Record<string, string | number>) ?? {};
      const spec = NEW_PLAN_STEPS[step];
      if (spec.kind === "text") {
        if (!raw || raw.length > 40) return void ctx.reply("❌ نام باید ۱ تا ۴۰ کاراکتر باشد.", { reply_markup: cancelKb("adm:pl") });
        vals[spec.key] = raw;
      } else {
        if (!isInt(raw)) return void ctx.reply("❌ فقط عدد بفرستید.", { reply_markup: cancelKb("adm:pl") });
        vals[spec.key] = num(raw);
      }
      if (step + 1 < NEW_PLAN_STEPS.length) {
        await setState(uid(ctx), "cat_pn", { step: step + 1, v: vals });
        return void ctx.reply(`➕ <b>پلن جدید</b> (${step + 2}/${NEW_PLAN_STEPS.length})\n\n${NEW_PLAN_STEPS[step + 1].ask}`, {
          parse_mode: "HTML",
          reply_markup: cancelKb("adm:pl"),
        });
      }
      const row = await queryOne<{ id: number }>(
        `INSERT INTO plans (name, cpu, ram_gb, ram_mb, disk_gb, hourly_price, monthly_price, active, virt_plid)
         VALUES ($1,$2,$3::int,$3::int*1024,$4,$5::bigint,$6,$5::bigint > 0,$7) RETURNING id`,
        [vals.name, vals.cpu, vals.ram, vals.disk, vals.hourly, vals.monthly || null, vals.plid || null],
      );
      await setState(uid(ctx), null);
      const p = await getPlan(row!.id);
      await ctx.reply("✅ پلن ساخته شد.");
      return void replyView(ctx, planView(p!));
    }

    // ویرایش لوکیشن
    if (st.state === "cat_le") {
      const key = String(d.key);
      if (d.f === "t") {
        if (!raw || raw.length > 40) return void ctx.reply("❌ عنوان باید ۱ تا ۴۰ کاراکتر باشد.", { reply_markup: cancelKb(`adm:lc:${key}`) });
        await query("UPDATE locations SET title=$2 WHERE key=$1", [key, raw]);
      } else {
        if (!isInt(raw, 100000)) return void ctx.reply("❌ فقط عدد بفرستید.", { reply_markup: cancelKb(`adm:lc:${key}`) });
        await query("UPDATE locations SET serid=$2 WHERE key=$1", [key, num(raw)]);
      }
      await setState(uid(ctx), null);
      const l = await getLoc(key);
      return void (l ? replyView(ctx, locView(l)) : ctx.reply("پیدا نشد."));
    }

    // لوکیشن جدید
    if (st.state === "cat_ln") {
      if (d.step === "serid") {
        if (!isInt(raw, 100000)) return void ctx.reply("❌ فقط عدد بفرستید (مثلاً 0).", { reply_markup: cancelKb("adm:lc") });
        await setState(uid(ctx), "cat_ln", { step: "title", serid: num(raw) });
        return void ctx.reply("عنوان لوکیشن را بفرستید (مثلاً 🇮🇷 ایران):", { reply_markup: cancelKb("adm:lc") });
      }
      if (!raw || raw.length > 40) return void ctx.reply("❌ عنوان باید ۱ تا ۴۰ کاراکتر باشد.", { reply_markup: cancelKb("adm:lc") });
      const serid = Number(d.serid);
      let key = `l${serid}`;
      for (let i = 2; await getLoc(key); i++) key = `l${serid}_${i}`;
      await query("INSERT INTO locations (key,title,serid) VALUES ($1,$2,$3)", [key, raw, serid]);
      await setState(uid(ctx), null);
      await ctx.reply("✅ لوکیشن ساخته شد.");
      return void replyView(ctx, locView((await getLoc(key))!));
    }

    // ویرایش سیستم‌عامل
    if (st.state === "cat_oe") {
      const key = String(d.key);
      if (d.f === "n") {
        if (!raw || raw.length > 40) return void ctx.reply("❌ نام باید ۱ تا ۴۰ کاراکتر باشد.", { reply_markup: cancelKb(`adm:os:${key}`) });
        await query("UPDATE os_templates SET name=$2 WHERE key=$1", [key, raw]);
      } else {
        if (!isInt(raw, 1e9)) return void ctx.reply("❌ فقط عدد بفرستید.", { reply_markup: cancelKb(`adm:os:${key}`) });
        await query("UPDATE os_templates SET osid=$2 WHERE key=$1", [key, num(raw)]);
      }
      await setState(uid(ctx), null);
      const o = await getOs(key);
      return void (o ? replyView(ctx, osView(o)) : ctx.reply("پیدا نشد."));
    }

    // جستجوی OS در پنل
    if (st.state === "cat_os_q") {
      const q = raw.toLowerCase();
      if (!q) return;
      await ctx.reply("⏳ در حال جستجو در پنل…");
      const dsc = await discover();
      if (!dsc.ok) return void ctx.reply("❌ اتصال به پنل برقرار نشد:\n" + (dsc.error ?? ""), { reply_markup: cancelKb("adm:os") });
      const all = q === "all";
      const found = dsc.os
        .filter((o) => (all || !o.virt || o.virt === config.virt.type) && (all || o.name.toLowerCase().includes(q)))
        .slice(0, 30);
      if (!found.length) return void ctx.reply("چیزی پیدا نشد؛ عبارت دیگری بفرستید:", { reply_markup: cancelKb("adm:os") });
      await setState(uid(ctx), "cat_os_pick", { list: found.map((o) => ({ id: o.id, name: o.name })) });
      const kb = new InlineKeyboard();
      found.forEach((o, i) => kb.text(`${o.name} (${o.id})`, `adm:oa:${i}`).row());
      kb.text("🔍 جستجوی دیگر", "adm:on").row().text("⬅️ بازگشت", "adm:os");
      return void ctx.reply("یکی را برای افزودن انتخاب کنید:", { reply_markup: kb });
    }

    // تنظیمات
    if (st.state === "cat_se") {
      const s = SETTINGS[Number(d.i)];
      if (!s) return;
      const back = { reply_markup: cancelKb("adm:set") };
      let value = raw;
      if (s.kind === "int" || s.kind === "percent") {
        if (!isInt(raw, s.kind === "percent" ? 99 : 1e12)) return void ctx.reply(s.kind === "percent" ? "❌ عددی بین ۰ تا ۹۹ بفرستید." : "❌ فقط عدد بفرستید.", back);
        value = String(num(raw));
      } else if (s.kind === "card") {
        value = normalizeDigits(raw);
        if (!/^[0-9-]{8,25}$/.test(value)) return void ctx.reply("❌ شماره کارت معتبر بفرستید (فقط عدد و خط تیره).", back);
      } else if (s.kind === "support") {
        value = raw.startsWith("@") ? raw : "@" + raw;
        if (!/^@[A-Za-z0-9_]{3,}$/.test(value)) return void ctx.reply("❌ یوزرنیم معتبر بفرستید (مثلاً @my_support).", back);
      } else if (!raw || raw.length > 60) return void ctx.reply("❌ مقدار باید ۱ تا ۶۰ کاراکتر باشد.", back);
      await setSetting(s.key, value);
      await setState(uid(ctx), null);
      await ctx.reply("✅ ذخیره شد.");
      return void replyView(ctx, await settingsView());
    }

    return next();
  });

  // بازنشانی یک تنظیم به مقدار env (در صورت نیاز در آینده)
  void resetSetting;
}

export { CAT_TEXT };

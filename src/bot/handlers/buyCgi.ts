import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { query, queryOne } from "@/core";
import { dayCost } from "@/lib/purchase";
import type { Plan } from "@/lib/types";
import { getDatacenter, isEnabled, isPurchasable } from "@/datacenters";
import { cgiCatalog } from "@/datacenters/cgi";
import { alert, esc, fmt, show, specText } from "../helpers";
import { performPurchase } from "./buy";

/**
 * جریان خرید اختصاصی CGI (بین‌الملل):
 *   لوکیشن (پرچم) ← سرویس (قیمت‌ها) ← سیستم‌عامل ← شبکه (رنج آی‌پی) ← نوع پرداخت ← ساخت و تحویل
 * ترتیب با جریان ایران فرق دارد، پس callbackها جدا هستند (cg:*). هر مرحله قبل از نمایش، ورودی را دوباره
 * از دیتابیس/API اعتبارسنجی می‌کند (به callback_data اعتماد نمی‌شود).
 */
const LOC_ORDER = ["cgi_paris", "cgi_nl", "cgi_lv", "cgi_fi"]; // پاریس، هلند / لاتویا، فنلاند

interface Loc { key: string; title: string; dc_ref: string }
interface Os { key: string; name: string; dc_ref: string }

const NET_OK = /^[\w-]{1,16}$/; // کوتاه نگه داشته می‌شود تا callback_data از ۶۴ بایت تلگرام بیشتر نشود
const PROBLEM = "⚠️ ارتباط با دیتاسنتر برقرار نشد؛ کمی بعد دوباره تلاش کنید.";

async function cgiLocs(): Promise<Loc[]> {
  const rows = await query<Loc>("SELECT key, title, dc_ref FROM locations WHERE datacenter='cgi' AND active AND dc_ref IS NOT NULL");
  const idx = (k: string) => (LOC_ORDER.includes(k) ? LOC_ORDER.indexOf(k) : 99);
  return rows.sort((a, b) => idx(a.key) - idx(b.key) || a.key.localeCompare(b.key));
}
const getLoc = (key: string) =>
  queryOne<Loc>("SELECT key, title, dc_ref FROM locations WHERE key=$1 AND datacenter='cgi' AND active AND dc_ref IS NOT NULL", [key]);

/** پلن‌های فعال و قیمت‌دارِ CGI که فلورشان در این ریجن وجود دارد */
async function plansIn(region: string): Promise<Plan[]> {
  // فقط پلن‌هایی که حداقل یک «پهنای باند» قیمت‌دار دارند فروخته می‌شوند
  const plans = await query<Plan>(
    `SELECT p.* FROM plans p WHERE p.datacenter='cgi' AND p.active AND p.hourly_price > 0 AND p.dc_ref IS NOT NULL
        AND EXISTS (SELECT 1 FROM bandwidth_prices b WHERE b.plan_id = p.id AND b.active)
      ORDER BY p.hourly_price, p.id`,
  );
  const ok = await Promise.all(plans.map((p) => cgiCatalog.hasFlavor(region, p.dc_ref!)));
  return plans.filter((_, i) => ok[i]);
}
type Sel = { loc: Loc; plan: Plan; os: Os; net: { name: string; cidr: string } };
interface Tier { mbps: number; hourly_price: number; monthly_price: number | null }
const tiersOf = (planId: number) =>
  query<Tier>("SELECT mbps, hourly_price, monthly_price FROM bandwidth_prices WHERE plan_id=$1 AND active ORDER BY mbps", [planId]);

async function getPlan(id: number, region: string): Promise<Plan | null> {
  const p = await queryOne<Plan>("SELECT * FROM plans WHERE id=$1 AND datacenter='cgi' AND active AND hourly_price > 0 AND dc_ref IS NOT NULL", [id]);
  return p && (await cgiCatalog.hasFlavor(region, p.dc_ref!)) ? p : null;
}
async function osIn(region: string): Promise<Os[]> {
  const rows = await query<Os>("SELECT key, name, dc_ref FROM os_templates WHERE datacenter='cgi' AND active AND dc_ref IS NOT NULL ORDER BY key");
  const ok = await Promise.all(rows.map((o) => cgiCatalog.hasImage(region, o.dc_ref)));
  return rows.filter((_, i) => ok[i]);
}
async function netsIn(region: string) {
  return (await cgiCatalog.networks(region)).filter((n) => NET_OK.test(n.name));
}

const chunk = <T,>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

/** خط قیمت یک پلن در لیست سرویس‌ها */
const priceLine = (p: Plan) =>
  `💸 PRICE : ${p.hourly_price} hourly` + (p.monthly_price ? ` ${fmt(p.monthly_price)} monthly` : "") + ` ${esc(p.name)}`;

export function registerBuyCgi(bot: Bot<BotContext>) {
  // ── ۱) لوکیشن (پرچم کشور) ──
  bot.callbackQuery("dc:cgi", async (ctx) => {
    const dc = getDatacenter("cgi");
    if (!dc || !(await isEnabled(dc.id))) return alert(ctx, "دیتاسنتر نامعتبر");
    if (!(await isPurchasable(dc))) return alert(ctx, "دیتاسنتر CGI به‌زودی فعال می‌شود.");
    const locs = await cgiLocs();
    if (locs.length === 0) return alert(ctx, "هنوز لوکیشنی برای CGI فعال نشده است.");
    const kb = new InlineKeyboard();
    for (const row of chunk(locs, 2)) {
      for (const l of row) kb.text(l.title, `cg:l:${l.key}`);
      kb.row();
    }
    kb.text("⬅️ بازگشت", "intl");
    await show(ctx, "لوکیشن سرور خود را انتخاب کنید:", kb);
  });

  // ── ۲) سرویس (پلن) ──
  bot.callbackQuery(/^cg:l:(\w+)$/, async (ctx) => {
    const loc = await getLoc(ctx.match[1]);
    if (!loc) return alert(ctx, "لوکیشن نامعتبر");
    const plans = await plansIn(loc.dc_ref).catch(() => null);
    if (!plans) return alert(ctx, PROBLEM);
    if (plans.length === 0) return alert(ctx, "هنوز سرویسی برای این لوکیشن فعال نشده است.");
    const kb = new InlineKeyboard();
    for (const p of plans) kb.text(p.name, `cg:p:${loc.key}:${p.id}`).row();
    kb.text("⬅️ بازگشت", "dc:cgi");
    await show(ctx, `سرویس مورد نظر خود را انتخاب نمایید :\n\n${plans.map(priceLine).join("\n\n")}`, kb);
  });

  // ── ۳) سیستم‌عامل ──
  bot.callbackQuery(/^cg:p:(\w+):(\d+)$/, async (ctx) => {
    const [, lk, pid] = ctx.match;
    const loc = await getLoc(lk);
    if (!loc) return alert(ctx, "لوکیشن نامعتبر");
    const [plan, oses] = await Promise.all([getPlan(Number(pid), loc.dc_ref), osIn(loc.dc_ref)]).catch(() => [null, null] as const);
    if (!plan || !oses) return alert(ctx, plan === null && oses === null ? PROBLEM : "سرویس نامعتبر");
    if (oses.length === 0) return alert(ctx, "سیستم‌عاملی برای این لوکیشن در دسترس نیست.");
    const kb = new InlineKeyboard();
    // ۳ سیستم‌عامل: اولی تنها، دو تای بعدی کنار هم (UBUNTU 20 / UBUNTU 22 · UBUNTU 24)
    const rows = oses.length === 3 ? [[oses[0]], [oses[1], oses[2]]] : chunk(oses, 2);
    for (const row of rows) {
      for (const o of row) kb.text(o.name, `cg:o:${lk}:${pid}:${o.key}`);
      kb.row();
    }
    kb.text("⬅️ بازگشت", `cg:l:${lk}`);
    await show(ctx, "سیستم عامل سرور خود را انتخاب نمایید ؛", kb);
  });

  // ── ۴) شبکه (رنج آی‌پی) ──
  bot.callbackQuery(/^cg:o:(\w+):(\d+):(\w+)$/, async (ctx) => {
    const [, lk, pid, ok] = ctx.match;
    const loc = await getLoc(lk);
    if (!loc) return alert(ctx, "لوکیشن نامعتبر");
    const r = await Promise.all([getPlan(Number(pid), loc.dc_ref), osIn(loc.dc_ref), netsIn(loc.dc_ref)]).catch(() => null);
    if (!r) return alert(ctx, PROBLEM);
    const [plan, oses, nets] = r;
    if (!plan || !oses.some((o) => o.key === ok)) return alert(ctx, "انتخاب نامعتبر");
    if (nets.length === 0) return alert(ctx, "شبکه‌ای برای این لوکیشن در دسترس نیست.");
    const kb = new InlineKeyboard();
    for (const row of chunk(nets, 3)) {
      for (const n of row) kb.text(n.name.toUpperCase(), `cg:n:${lk}:${pid}:${ok}:${n.name}`);
      kb.row();
    }
    kb.text("⬅️ بازگشت", `cg:p:${lk}:${pid}`);
    const list = nets.map((n) => `${esc(n.name.toUpperCase())} : <code>${esc(n.cidr)}</code>`).join("\n");
    await show(ctx, `شبکه مورد نظر خود را انتخاب نمایید :\n\nلیست آیپی رنج شبکه ها :\n\n${list}`, kb);
  });

  // ── ۵) پهنای باند (قیمت تمام‌شده‌ی سرور برای هر سرعت) ──
  bot.callbackQuery(/^cg:n:(\w+):(\d+):(\w+):([\w-]+)$/, async (ctx) => {
    const [, lk, pid, ok, netRaw] = ctx.match;
    const sel = await validate(lk, Number(pid), ok, netRaw);
    if (!sel) return alert(ctx, "انتخاب نامعتبر");
    if ("problem" in sel) return alert(ctx, sel.problem);
    const tiers = await tiersOf(sel.plan.id);
    if (tiers.length === 0) return alert(ctx, "هنوز پهنای باندی برای این سرویس فعال نشده است.");
    const kb = new InlineKeyboard();
    for (const t of tiers) kb.text(`${t.mbps}MB`, `cg:w:${lk}:${pid}:${ok}:${sel.net.name}:${t.mbps}`).row();
    kb.text("⬅️ بازگشت", `cg:o:${lk}:${pid}:${ok}`);
    const list = tiers
      .map((t) => `پهناباند ${t.mbps} مگابیتی نامحدود : ${t.monthly_price ? fmt(t.monthly_price) : "—"}\nساعتی : ${t.hourly_price}`)
      .join("\n\n");
    await show(
      ctx,
      `مقدار پهناباند مورد نظر را انتخاب نمایید :\n\n⚠️   توجه نمایید پهنا باند قیمت جدا دارد و قیمت نمایش داده شده در لیست زیر قیمت تموم شده سرور شما میباشد !\n\n${list}`,
      kb,
    );
  });

  // ── ۶) خلاصه + نوع پرداخت (هزینه بر اساس پهنای باند انتخابی) ──
  bot.callbackQuery(/^cg:w:(\w+):(\d+):(\w+):([\w-]+):(\d+)$/, async (ctx) => {
    const [, lk, pid, ok, netRaw, bw] = ctx.match;
    const sel = await validate(lk, Number(pid), ok, netRaw);
    if (!sel) return alert(ctx, "انتخاب نامعتبر");
    if ("problem" in sel) return alert(ctx, sel.problem);
    const tier = (await tiersOf(sel.plan.id)).find((t) => t.mbps === Number(bw));
    if (!tier) return alert(ctx, "انتخاب نامعتبر");
    const { plan, loc, os, net } = sel;

    let text =
      `🖥 <b>${esc(plan.name)}</b>\n\n` +
      `⚙️ مشخصات: ${specText(plan)}\n` +
      `🌍 لوکیشن: ${esc(loc.title)}\n` +
      `💿 سیستم‌عامل: ${esc(os.name)}\n` +
      `🌐 شبکه: ${esc(net.name.toUpperCase())} (<code>${esc(net.cidr)}</code>)\n` +
      `📶 پهناباند: ${tier.mbps} مگابیت نامحدود\n\n` +
      `⏰ ساعتی: <b>${tier.hourly_price}</b> تومان در ساعت\n` +
      (tier.monthly_price ? `🗓 ماهانه: <b>${fmt(tier.monthly_price)}</b> تومان\n` : "") +
      `\n<b>نوع پرداخت را انتخاب کنید:</b>\n` +
      `• ساعتی: هزینه‌ی یک ساعت همین حالا کسر می‌شود و هر ساعت از موجودی حساب کم می‌شود.\n`;
    const base = `${lk}:${pid}:${ok}:${net.name}:${tier.mbps}`;
    const kb = new InlineKeyboard().text(`⏰ ساعتی (${tier.hourly_price} تومان)`, `cg:b:h:${base}`);
    if (tier.monthly_price) {
      const day = dayCost(tier.monthly_price);
      text +=
        `• ماهانه: برای تست، هزینه‌ی <b>یک روز</b> (${fmt(day)} تومان) کسر می‌شود. اگر تا ۲۴ ساعت مشکلی گزارش نشود، ` +
        `مابقی مبلغ ماهانه (${fmt(tier.monthly_price - day)} تومان) کسر شده و سپس هر ۳۰ روز تمدید می‌شود.\n`;
      kb.text(`🗓 ماهانه (${fmt(tier.monthly_price)} تومان)`, `cg:b:m:${base}`);
    }
    kb.row().text("⬅️ بازگشت به پهناباند", `cg:n:${lk}:${pid}:${ok}:${net.name}`);
    await show(ctx, text, kb);
  });

  // ── ۷) خرید: کسر هزینه (بر اساس پهنای باند) + ساخت و تحویل ──
  bot.callbackQuery(/^cg:b:([hm]):(\w+):(\d+):(\w+):([\w-]+):(\d+)$/, async (ctx) => {
    const [, m, lk, pid, ok, netRaw, bw] = ctx.match;
    const sel = await validate(lk, Number(pid), ok, netRaw);
    if (!sel) return alert(ctx, "انتخاب نامعتبر");
    if ("problem" in sel) return alert(ctx, sel.problem);
    await performPurchase(ctx, {
      planId: sel.plan.id,
      locKey: sel.loc.key,
      osKey: ok,
      mode: m === "m" ? "monthly" : "hourly",
      dcMeta: { network: sel.net.name, bandwidth: Number(bw) }, // قیمت نهایی در purchaseService از روی همین سرعت تعیین می‌شود
    });
  });

  /** اعتبارسنجی کامل انتخاب‌ها (به callback_data اعتماد نمی‌شود). null = نامعتبر؛ {problem} = خطای ارتباط */
  async function validate(lk: string, pid: number, ok: string, netRaw: string): Promise<Sel | { problem: string } | null> {
    const loc = await getLoc(lk);
    if (!loc) return null;
    const r = await Promise.all([getPlan(pid, loc.dc_ref), osIn(loc.dc_ref), netsIn(loc.dc_ref)]).catch(() => null);
    if (!r) return { problem: PROBLEM };
    const [plan, oses, nets] = r;
    const os = oses.find((o) => o.key === ok);
    const net = nets.find((n) => n.name.toLowerCase() === netRaw.toLowerCase());
    if (!plan || !os || !net) return null;
    return { loc, plan, os, net };
  }
}

import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { config } from "@/lib/config";
import { query, queryOne } from "@/lib/db";
import { dayCost, purchaseService } from "@/lib/purchase";
import { startProvisioning } from "@/lib/provisioning";
import type { Plan } from "@/lib/types";
import { alert, esc, fmt, planButton, show, specText, uid } from "../helpers";
import { backKb } from "../keyboards";
import { getSettings } from "@/lib/settings";
import { codes, payerInfo, report, stamp } from "@/lib/adminGroup";
import { getDatacenter, isEnabled, isPurchasable, listDatacenters } from "@/datacenters";

interface Loc {
  key: string;
  title: string;
  datacenter: string;
}
interface Os {
  key: string;
  name: string;
  datacenter: string;
}

const getLoc = (key: string) =>
  queryOne<Loc>("SELECT key, title, datacenter FROM locations WHERE key=$1 AND active", [key]);
const getOs = (key: string) =>
  queryOne<Os>("SELECT key, name, datacenter FROM os_templates WHERE key=$1 AND active", [key]);

// مراحل: لوکیشن ← سیستم‌عامل ← (بررسی موجودی) ← پلن ← تأیید و ساخت
export function registerBuy(bot: Bot<BotContext>) {
  bot.callbackQuery("buy", async (ctx) => {
    // ایران: لوکیشن‌های دیتاسنتر Virtualizor؛ بین‌الملل: انتخاب دیتاسنتر (هرکدام مستقل)
    const kb = new InlineKeyboard();
    for (const dc of listDatacenters("ir")) {
      if (!(await isEnabled(dc.id))) continue;
      const locs = await query<Loc>("SELECT key, title, datacenter FROM locations WHERE active AND datacenter=$1 ORDER BY key", [dc.id]);
      for (const l of locs) kb.text(l.title, `loc:${l.key}`).row();
    }
    let hasIntl = false;
    for (const dc of listDatacenters("intl")) if (await isEnabled(dc.id)) hasIntl = true;
    if (hasIntl) kb.text("🌍 بین‌الملل", "intl").row();
    kb.text("🔙 منوی اصلی", "home");
    await show(ctx, "🌍 <b>لوکیشن سرور را انتخاب کنید:</b>", kb);
  });

  // ── بین‌الملل: انتخاب دیتاسنتر (مستقل از Virtualizor) ──
  bot.callbackQuery("intl", async (ctx) => {
    const kb = new InlineKeyboard();
    for (const d of listDatacenters("intl")) if (await isEnabled(d.id)) kb.text(d.title, `dc:${d.id}`).row();
    kb.text("⬅️ بازگشت", "buy");
    await show(ctx, "دیتاسنتر مورد نظر خود را انتخاب کنید:", kb);
  });

  bot.callbackQuery(/^dc:(\w+)$/, async (ctx) => {
    const dc = getDatacenter(ctx.match[1]);
    if (!dc || !(await isEnabled(dc.id))) return alert(ctx, "دیتاسنتر نامعتبر");
    if (!(await isPurchasable(dc))) return alert(ctx, `دیتاسنتر ${dc.title} به‌زودی فعال می‌شود.`);
    // دیتاسنتر آماده: لوکیشن‌های همان دیتاسنتر ← همان جریان استاندارد (سیستم‌عامل ← پلن ← خرید)
    const locs = await query<Loc>("SELECT key, title, datacenter FROM locations WHERE active AND datacenter=$1 ORDER BY key", [dc.id]);
    if (locs.length === 0) return alert(ctx, `برای ${dc.title} هنوز لوکیشنی تعریف نشده است.`);
    const kb = new InlineKeyboard();
    for (const l of locs) kb.text(l.title, `loc:${l.key}`).row();
    kb.text("⬅️ بازگشت", "intl");
    await show(ctx, `🌍 <b>${esc(dc.title)}</b>\n\nلوکیشن را انتخاب کنید:`, kb);
  });

  bot.callbackQuery(/^loc:(\w+)$/, async (ctx) => {
    const loc = await getLoc(ctx.match[1]);
    if (!loc) return alert(ctx, "لوکیشن نامعتبر");
    const oses = await query<Os>("SELECT key, name, datacenter FROM os_templates WHERE active AND datacenter=$1 ORDER BY name", [loc.datacenter]);
    if (oses.length === 0) return alert(ctx, "هنوز سیستم‌عاملی تعریف نشده است.");
    const kb = new InlineKeyboard();
    for (const o of oses) kb.text(`🐧 ${o.name}`, `os:${loc.key}:${o.key}`).row();
    kb.text("⬅️ بازگشت", "buy");
    await show(ctx, `${esc(loc.title)}\n\n💿 <b>سیستم‌عامل را انتخاب کنید:</b>`, kb);
  });

  bot.callbackQuery(/^os:(\w+):(\w+)$/, async (ctx) => {
    const [, lk, ok] = ctx.match;
    const [loc, os] = await Promise.all([getLoc(lk), getOs(ok)]);
    if (!loc || !os || os.datacenter !== loc.datacenter) return alert(ctx, "انتخاب نامعتبر");

    const u = await queryOne<{ balance: number }>("SELECT balance FROM users WHERE id=$1", [uid(ctx)]);
    const balance = u?.balance ?? 0;
    const minBal = (await getSettings()).minBalanceToBuy;
    if (balance < minBal) {
      return alert(
        ctx,
        `❌ موجودی شما کم است.\nحداقل موجودی برای ساخت سرویس ${fmt(minBal)} تومان است.\nموجودی فعلی: ${fmt(balance)} تومان`,
      );
    }

    const plans = await query<Plan>("SELECT * FROM plans WHERE active AND hourly_price > 0 AND datacenter=$1 ORDER BY hourly_price", [loc.datacenter]);
    if (plans.length === 0) return alert(ctx, "هنوز پلنی برای فروش فعال نشده است.");
    const kb = new InlineKeyboard();
    for (const p of plans) {
      kb.text(planButton(p), `plan:${p.id}:${lk}:${ok}`).row();
    }
    kb.text("⬅️ بازگشت", `loc:${lk}`);
    const list = plans
      .map(
        (p) =>
          `🔻${esc(p.name)}\n⏰hourly : ${p.hourly_price} toman` +
          (p.monthly_price ? `\n🗓 monthly: ${fmt(p.monthly_price)} toman` : ""),
      )
      .join("\n\n\n");
    await show(ctx, `${esc(loc.title)} | ${esc(os.name)}\n\n🛒 <b>پلن را انتخاب کنید:</b>\n\n${list}`, kb);
  });

  // ── اطلاعات کامل پلن + انتخاب نوع پرداخت (ساعتی / ماهانه) ──
  bot.callbackQuery(/^plan:(\d+):(\w+):(\w+)$/, async (ctx) => {
    const [, pid, lk, ok] = ctx.match;
    const [p, loc, os] = await Promise.all([
      queryOne<Plan>("SELECT * FROM plans WHERE id=$1 AND active", [Number(pid)]),
      getLoc(lk),
      getOs(ok),
    ]);
    if (!p || !loc || !os || p.datacenter !== loc.datacenter || os.datacenter !== loc.datacenter) return alert(ctx, "پلن یافت نشد");
    let text =
      `🖥 <b>${esc(p.name)}</b>\n\n` +
      `⚙️ مشخصات: ${specText(p)}\n` +
      `🌍 لوکیشن: ${esc(loc.title)}\n` +
      `💿 سیستم‌عامل: ${esc(os.name)}\n\n` +
      `⏰ ساعتی: <b>${p.hourly_price}</b> تومان در ساعت\n` +
      (p.monthly_price ? `🗓 ماهانه: <b>${fmt(p.monthly_price)}</b> تومان\n` : "") +
      `\n<b>نوع پرداخت را انتخاب کنید:</b>\n` +
      `• ساعتی: هزینه‌ی یک ساعت همین حالا کسر می‌شود و هر ساعت از موجودی حساب کم می‌شود.\n`;
    const kb = new InlineKeyboard().text(`⏰ ساعتی (${p.hourly_price} تومان)`, `buyc:h:${pid}:${lk}:${ok}`);
    if (p.monthly_price) {
      const day = dayCost(p.monthly_price);
      text +=
        `• ماهانه: برای تست، هزینه‌ی <b>یک روز</b> (${fmt(day)} تومان) کسر می‌شود. اگر تا ۲۴ ساعت مشکلی گزارش نشود، ` +
        `مابقی مبلغ ماهانه (${fmt(p.monthly_price - day)} تومان) کسر شده و سپس هر ۳۰ روز تمدید می‌شود.\n`;
      kb.text(`🗓 ماهانه (${fmt(p.monthly_price)} تومان)`, `buyc:m:${pid}:${lk}:${ok}`);
    }
    kb.row().text("⬅️ بازگشت به پلن‌ها", `os:${lk}:${ok}`);
    await show(ctx, text, kb);
  });

  bot.callbackQuery(/^buyc:([hm]):(\d+):(\w+):(\w+)$/, async (ctx) => {
    const [, m, pid, lk, ok] = ctx.match;
    await performPurchase(ctx, { planId: Number(pid), locKey: lk, osKey: ok, mode: m === "m" ? "monthly" : "hourly" });
  });
}

/**
 * ثبت خرید (کسر هزینه + ساخت در پس‌زمینه) — مشترک بین جریان استاندارد و جریان اختصاصی CGI.
 */
export async function performPurchase(
  ctx: BotContext,
  i: { planId: number; locKey: string; osKey: string; mode: "hourly" | "monthly"; dcMeta?: { network?: string; bandwidth?: number } },
) {
  const mode = i.mode;
  // ۱) کسر هزینه + ثبت سرویس (provisioning) در یک تراکنش سریع؛ ساخت روی دیتاسنتر بعد از commit
  const result = await purchaseService({ userId: uid(ctx), planId: i.planId, locKey: i.locKey, osKey: i.osKey, mode, dcMeta: i.dcMeta }).catch(
    (e) => {
      console.error("buy error", e);
      return { error: "❌ خطا در ثبت سفارش. مبلغی کسر نشد، دوباره تلاش کنید." };
    },
  );
  if ("error" in result) return alert(ctx, result.error);

  void (async () =>
    report(
      ctx.api,
      "finance",
      `🛒 <b>خرید سرویس</b> — کد <code>${codes.buy(result.sid)}</code>\n🕒 ${stamp()}\n` +
        `🖥 سرور #${result.sid} | ${mode === "monthly" ? "🗓 ماهانه (هزینه‌ی روز تست)" : "⏰ ساعتی"}\n` +
        `💵 کسر شده: <b>${fmt(result.charged)}</b> تومان\n${await payerInfo(uid(ctx))}`,
    ))().catch(() => {});

  // ۲) ساخت در پس‌زمینه (ممکن است چند ده ثانیه طول بکشد)
  void startProvisioning(ctx.api, result.sid);
  await show(
    ctx,
    `⏳ <b>سرور #${result.sid} در حال ساخت است…</b>\n` +
      (mode === "monthly"
        ? `🗓 سرویس ماهانه — هزینه‌ی یک روز تست (${fmt(result.charged)} تومان) کسر شد.\n`
        : `⏰ سرویس ساعتی — ${fmt(result.charged)} تومان کسر شد.\n`) +
      `معمولاً کمتر از چند دقیقه طول می‌کشد؛ به‌محض آماده شدن، مشخصات برای شما ارسال می‌شود.`,
    backKb([["📦 سرویس‌های من", "services"]]),
  );
}

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

interface Loc {
  key: string;
  title: string;
}
interface Os {
  key: string;
  name: string;
}

const getLoc = (key: string) =>
  queryOne<Loc>("SELECT key, title FROM locations WHERE key=$1 AND active", [key]);
const getOs = (key: string) => queryOne<Os>("SELECT key, name FROM os_templates WHERE key=$1 AND active", [key]);

// مراحل: لوکیشن ← سیستم‌عامل ← (بررسی موجودی) ← پلن ← تأیید و ساخت
export function registerBuy(bot: Bot<BotContext>) {
  bot.callbackQuery("buy", async (ctx) => {
    const locs = await query<Loc>("SELECT key, title FROM locations WHERE active ORDER BY key");
    if (locs.length === 0) {
      return show(
        ctx,
        "⚠️ در حال حاضر امکان خرید وجود ندارد (لوکیشنی تعریف نشده). با پشتیبانی تماس بگیرید.",
        backKb([]),
      );
    }
    const kb = new InlineKeyboard();
    for (const l of locs) kb.text(l.title, `loc:${l.key}`).row();
    kb.text("🔙 منوی اصلی", "home");
    await show(ctx, "🌍 <b>لوکیشن سرور را انتخاب کنید:</b>", kb);
  });

  bot.callbackQuery(/^loc:(\w+)$/, async (ctx) => {
    const loc = await getLoc(ctx.match[1]);
    if (!loc) return alert(ctx, "لوکیشن نامعتبر");
    const oses = await query<Os>("SELECT key, name FROM os_templates WHERE active ORDER BY name");
    if (oses.length === 0) return alert(ctx, "هنوز سیستم‌عاملی تعریف نشده است.");
    const kb = new InlineKeyboard();
    for (const o of oses) kb.text(`🐧 ${o.name}`, `os:${loc.key}:${o.key}`).row();
    kb.text("⬅️ بازگشت", "buy");
    await show(ctx, `${esc(loc.title)}\n\n💿 <b>سیستم‌عامل را انتخاب کنید:</b>`, kb);
  });

  bot.callbackQuery(/^os:(\w+):(\w+)$/, async (ctx) => {
    const [, lk, ok] = ctx.match;
    const [loc, os] = await Promise.all([getLoc(lk), getOs(ok)]);
    if (!loc || !os) return alert(ctx, "انتخاب نامعتبر");

    const u = await queryOne<{ balance: number }>("SELECT balance FROM users WHERE id=$1", [uid(ctx)]);
    const balance = u?.balance ?? 0;
    if (balance < config.minBalanceToBuy) {
      return alert(
        ctx,
        `❌ موجودی شما کم است.\nحداقل موجودی برای ساخت سرویس ${fmt(config.minBalanceToBuy)} تومان است.\nموجودی فعلی: ${fmt(balance)} تومان`,
      );
    }

    const plans = await query<Plan>("SELECT * FROM plans WHERE active AND hourly_price > 0 ORDER BY hourly_price");
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
    if (!p || !loc || !os) return alert(ctx, "پلن یافت نشد");
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
    const mode = m === "m" ? "monthly" : "hourly";

    // ۱) کسر هزینه + ثبت سرویس (provisioning) در یک تراکنش سریع؛ ساخت روی پنل بعد از commit
    const result = await purchaseService({ userId: uid(ctx), planId: Number(pid), locKey: lk, osKey: ok, mode }).catch(
      (e) => {
        console.error("buy error", e);
        return { error: "❌ خطا در ثبت سفارش. مبلغی کسر نشد، دوباره تلاش کنید." };
      },
    );
    if ("error" in result) return alert(ctx, result.error);

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
  });
}

import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { config } from "@/lib/config";
import { query, queryOne, withTx } from "@/lib/db";
import { genPassword } from "@/lib/provider";
import { startProvisioning } from "@/lib/provisioning";
import type { Plan } from "@/lib/types";
import { alert, esc, fmt, show, specText, uid } from "../helpers";
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
      kb.text(
        `${p.name} | ${specText(p)} | ${fmt(p.hourly_price)} ت/ساعت`,
        `plan:${p.id}:${lk}:${ok}`,
      ).row();
    }
    kb.text("⬅️ بازگشت", `loc:${lk}`);
    await show(ctx, `${esc(loc.title)} | ${esc(os.name)}\n\n🛒 <b>پلن را انتخاب کنید:</b>`, kb);
  });

  bot.callbackQuery(/^plan:(\d+):(\w+):(\w+)$/, async (ctx) => {
    const [, pid, lk, ok] = ctx.match;
    const [p, loc, os] = await Promise.all([
      queryOne<Plan>("SELECT * FROM plans WHERE id=$1 AND active", [Number(pid)]),
      getLoc(lk),
      getOs(ok),
    ]);
    if (!p || !loc || !os) return alert(ctx, "پلن یافت نشد");
    const text =
      `🖥 <b>${esc(p.name)}</b>\n` +
      `مشخصات: ${specText(p)}\n` +
      `لوکیشن: ${esc(loc.title)}\nسیستم‌عامل: ${esc(os.name)}\n` +
      `قیمت: <b>${fmt(p.hourly_price)}</b> تومان در ساعت\n\nپرداخت ساعتی از موجودی حساب کسر می‌شود.`;
    await show(
      ctx,
      text,
      backKb([
        ["✅ تأیید و ساخت سرویس", `buyc:${pid}:${lk}:${ok}`],
        ["⬅️ بازگشت به پلن‌ها", `os:${lk}:${ok}`],
      ]),
    );
  });

  bot.callbackQuery(/^buyc:(\d+):(\w+):(\w+)$/, async (ctx) => {
    const [, pid, lk, ok] = ctx.match;
    const userId = uid(ctx);

    // ۱) کسر هزینه + ثبت سرویس (provisioning) در یک تراکنش سریع؛ ساخت روی پنل بعد از commit
    const result = await withTx(async (c) => {
      const p = (await c.query<Plan>("SELECT * FROM plans WHERE id=$1 AND active", [Number(pid)])).rows[0];
      const loc = (await c.query<Loc>("SELECT key, title FROM locations WHERE key=$1 AND active", [lk])).rows[0];
      const os = (await c.query<Os>("SELECT key, name FROM os_templates WHERE key=$1 AND active", [ok])).rows[0];
      const u = (await c.query<{ balance: number }>("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [userId]))
        .rows[0];
      if (!p || !loc || !os || !u) return { error: "❌ خطا در ثبت سفارش" };
      if (u.balance < Math.max(config.minBalanceToBuy, p.hourly_price)) {
        return { error: `❌ موجودی شما کم است. حداقل موجودی برای ساخت سرویس ${fmt(config.minBalanceToBuy)} تومان است.` };
      }
      await c.query("UPDATE users SET balance = balance - $1 WHERE id=$2", [p.hourly_price, userId]);
      const sid = (
        await c.query<{ id: number }>(
          `INSERT INTO services (user_id, plan_id, hourly_price, location, os, location_key, os_key,
                                 status, login_user, login_pass, panel_pass)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'provisioning','root',$8,$9) RETURNING id`,
          [userId, p.id, p.hourly_price, loc.title, os.name, loc.key, os.key, genPassword(), genPassword()],
        )
      ).rows[0].id;
      return { sid };
    }).catch((e) => {
      console.error("buy error", e);
      return { error: "❌ خطا در ثبت سفارش. مبلغی کسر نشد، دوباره تلاش کنید." };
    });

    if ("error" in result) return alert(ctx, result.error!);

    // ۲) ساخت در پس‌زمینه (ممکن است چند ده ثانیه طول بکشد)
    void startProvisioning(ctx.api, result.sid!);
    await show(
      ctx,
      `⏳ <b>سرور #${result.sid} در حال ساخت است…</b>\nمعمولاً کمتر از چند دقیقه طول می‌کشد؛ به‌محض آماده شدن، مشخصات برای شما ارسال می‌شود.`,
      backKb([["📦 سرویس‌های من", "services"]]),
    );
  });
}

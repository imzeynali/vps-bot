import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { config, LOCATIONS, OS_LIST } from "@/lib/config";
import { query, queryOne, withTx } from "@/lib/db";
import { provisionServer } from "@/lib/provider";
import type { Plan } from "@/lib/types";
import { alert, fmt, show, uid } from "../helpers";
import { backKb } from "../keyboards";

// مراحل: لوکیشن ← سیستم‌عامل ← (بررسی موجودی) ← پلن ← تأیید و ساخت
export function registerBuy(bot: Bot<BotContext>) {
  bot.callbackQuery("buy", async (ctx) => {
    const kb = new InlineKeyboard();
    for (const [key, title] of Object.entries(LOCATIONS)) kb.text(title, `loc:${key}`).row();
    kb.text("🔙 منوی اصلی", "home");
    await show(ctx, "🌍 <b>لوکیشن سرور را انتخاب کنید:</b>", kb);
  });

  bot.callbackQuery(/^loc:(\w+)$/, async (ctx) => {
    const loc = ctx.match[1];
    if (!LOCATIONS[loc]) return alert(ctx, "لوکیشن نامعتبر");
    const kb = new InlineKeyboard();
    for (const [key, title] of Object.entries(OS_LIST)) kb.text(`🐧 ${title}`, `os:${loc}:${key}`).row();
    kb.text("⬅️ بازگشت", "buy");
    await show(ctx, `${LOCATIONS[loc]}\n\n💿 <b>سیستم‌عامل را انتخاب کنید:</b>`, kb);
  });

  bot.callbackQuery(/^os:(\w+):(\w+)$/, async (ctx) => {
    const [, loc, os] = ctx.match;
    if (!LOCATIONS[loc] || !OS_LIST[os]) return alert(ctx, "انتخاب نامعتبر");

    const u = await queryOne<{ balance: number }>("SELECT balance FROM users WHERE id=$1", [uid(ctx)]);
    const balance = u?.balance ?? 0;
    if (balance < config.minBalanceToBuy) {
      return alert(
        ctx,
        `❌ موجودی شما کم است.\nحداقل موجودی برای ساخت سرویس ${fmt(config.minBalanceToBuy)} تومان است.\nموجودی فعلی: ${fmt(balance)} تومان`,
      );
    }

    const plans = await query<Plan>("SELECT * FROM plans WHERE active ORDER BY hourly_price");
    const kb = new InlineKeyboard();
    for (const p of plans) {
      kb.text(
        `${p.name} | ${p.cpu}C/${p.ram_gb}G/${p.disk_gb}G | ${fmt(p.hourly_price)} ت/ساعت`,
        `plan:${p.id}:${loc}:${os}`,
      ).row();
    }
    kb.text("⬅️ بازگشت", `loc:${loc}`);
    await show(ctx, `${LOCATIONS[loc]} | ${OS_LIST[os]}\n\n🛒 <b>پلن را انتخاب کنید:</b>`, kb);
  });

  bot.callbackQuery(/^plan:(\d+):(\w+):(\w+)$/, async (ctx) => {
    const [, pid, loc, os] = ctx.match;
    const p = await queryOne<Plan>("SELECT * FROM plans WHERE id=$1 AND active", [Number(pid)]);
    if (!p || !LOCATIONS[loc] || !OS_LIST[os]) return alert(ctx, "پلن یافت نشد");
    const text =
      `🖥 <b>${p.name}</b>\n` +
      `CPU: ${p.cpu} هسته\nRAM: ${p.ram_gb} گیگ\nدیسک: ${p.disk_gb} گیگ\n` +
      `لوکیشن: ${LOCATIONS[loc]}\nسیستم‌عامل: ${OS_LIST[os]}\n` +
      `قیمت: <b>${fmt(p.hourly_price)}</b> تومان در ساعت\n\nپرداخت ساعتی از موجودی حساب کسر می‌شود.`;
    await show(
      ctx,
      text,
      backKb([
        ["✅ تأیید و ساخت سرویس", `buyc:${pid}:${loc}:${os}`],
        ["⬅️ بازگشت به پلن‌ها", `os:${loc}:${os}`],
      ]),
    );
  });

  bot.callbackQuery(/^buyc:(\d+):(\w+):(\w+)$/, async (ctx) => {
    const [, pid, loc, os] = ctx.match;
    if (!LOCATIONS[loc] || !OS_LIST[os]) return alert(ctx, "انتخاب نامعتبر");
    const userId = uid(ctx);

    const result = await withTx(async (c) => {
      const p = (await c.query<Plan>("SELECT * FROM plans WHERE id=$1 AND active", [Number(pid)])).rows[0];
      const u = (await c.query<{ balance: number }>("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [userId]))
        .rows[0];
      if (!p || !u) return { error: "خطا در ثبت سفارش" };
      if (u.balance < Math.max(config.minBalanceToBuy, p.hourly_price)) {
        return { error: `❌ موجودی شما کم است. حداقل موجودی برای ساخت سرویس ${fmt(config.minBalanceToBuy)} تومان است.` };
      }
      await c.query("UPDATE users SET balance = balance - $1 WHERE id=$2", [p.hourly_price, userId]);
      const sid = (
        await c.query<{ id: number }>(
          `INSERT INTO services (user_id, plan_id, hourly_price, location, os)
           VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [userId, p.id, p.hourly_price, LOCATIONS[loc], OS_LIST[os]],
        )
      ).rows[0].id;
      const info = await provisionServer({ serviceId: sid, planName: p.name, osName: OS_LIST[os] });
      await c.query("UPDATE services SET ip=$1, login_user=$2, login_pass=$3 WHERE id=$4", [
        info.ip,
        info.username,
        info.password,
        sid,
      ]);
      return { sid };
    }).catch((e) => {
      console.error("buy error", e);
      return { error: "❌ خطا در ساخت سرور. مبلغی کسر نشد، دوباره تلاش کنید." };
    });

    if ("error" in result) return alert(ctx, result.error!);
    await show(
      ctx,
      `✅ سرور #${result.sid} ساخته شد.\nمشخصات را از بخش «سرویس‌های من» ببینید.`,
      backKb([["📦 سرویس‌های من", "services"]]),
    );
  });
}

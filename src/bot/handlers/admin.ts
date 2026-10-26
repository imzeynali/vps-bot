import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { config } from "@/lib/config";
import { query, withTx } from "@/lib/db";
import { alert, fmt, uid } from "../helpers";

const isAdmin = (ctx: BotContext) => config.admins.includes(uid(ctx));

export function registerAdmin(bot: Bot<BotContext>) {
  // /addplan نام|cpu|ram|disk|قیمت_ساعتی
  bot.command("addplan", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const parts = ctx.match.split("|").map((x) => x.trim());
    const [name, cpu, ram, disk, price] = parts;
    if (parts.length !== 5 || [cpu, ram, disk, price].some((x) => !/^\d+$/.test(x))) {
      return void ctx.reply("فرمت: /addplan نام|cpu|ram|disk|قیمت_ساعتی");
    }
    await query("INSERT INTO plans (name,cpu,ram_gb,disk_gb,hourly_price) VALUES ($1,$2,$3,$4,$5)", [
      name,
      Number(cpu),
      Number(ram),
      Number(disk),
      Number(price),
    ]);
    await ctx.reply("✅ پلن اضافه شد.");
  });

  // /addbalance user_id amount
  bot.command("addbalance", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [u, a] = ctx.match.trim().split(/\s+/);
    if (!/^\d+$/.test(u ?? "") || !/^-?\d+$/.test(a ?? "")) {
      return void ctx.reply("فرمت: /addbalance user_id amount");
    }
    await query("UPDATE users SET balance = balance + $1 WHERE id=$2", [Number(a), Number(u)]);
    await ctx.reply("✅ انجام شد.");
  });

  // تأیید پرداخت
  bot.callbackQuery(/^payok:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return alert(ctx, "دسترسی ندارید");
    const pid = Number(ctx.match[1]);

    const out = await withTx(async (c) => {
      const p = (
        await c.query<{ id: number; user_id: number; amount: number }>(
          "UPDATE payments SET status='approved', approved_at=now() WHERE id=$1 AND status='pending' RETURNING id, user_id, amount",
          [pid],
        )
      ).rows[0];
      if (!p) return null;

      await c.query("UPDATE users SET balance = balance + $1 WHERE id=$2", [p.amount, p.user_id]);
      const ref = (await c.query<{ referrer_id: number | null }>("SELECT referrer_id FROM users WHERE id=$1", [p.user_id]))
        .rows[0]?.referrer_id;

      let bonus = 0;
      if (ref) {
        bonus = Math.floor((p.amount * config.refPercent) / 100);
        await c.query("UPDATE users SET balance = balance + $1 WHERE id=$2", [bonus, ref]);
        await c.query("INSERT INTO referral_earnings (referrer_id, referred_id, amount) VALUES ($1,$2,$3)", [
          ref,
          p.user_id,
          bonus,
        ]);
      }
      return { p, ref, bonus };
    });

    if (!out) return alert(ctx, "قبلاً بررسی شده");
    await ctx.editMessageCaption({ caption: `${ctx.callbackQuery.message?.caption ?? ""}\n\n✅ تأیید شد` });
    await ctx.answerCallbackQuery();
    await ctx.api.sendMessage(out.p.user_id, `✅ حساب شما به مبلغ ${fmt(out.p.amount)} تومان شارژ شد.`).catch(() => {});
    if (out.ref && out.bonus > 0) {
      await ctx.api
        .sendMessage(out.ref, `🎉 مبلغ ${fmt(out.bonus)} تومان پورسانت زیرمجموعه به حساب شما اضافه شد.`)
        .catch(() => {});
    }
  });

  // رد پرداخت
  bot.callbackQuery(/^payno:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return alert(ctx, "دسترسی ندارید");
    const pid = Number(ctx.match[1]);
    const rows = await query<{ user_id: number }>(
      "UPDATE payments SET status='rejected' WHERE id=$1 AND status='pending' RETURNING user_id",
      [pid],
    );
    if (rows.length === 0) return alert(ctx, "قبلاً بررسی شده");
    await ctx.editMessageCaption({ caption: `${ctx.callbackQuery.message?.caption ?? ""}\n\n❌ رد شد` });
    await ctx.answerCallbackQuery();
    await ctx.api
      .sendMessage(rows[0].user_id, `❌ پرداخت #${pid} تأیید نشد. با پشتیبانی تماس بگیرید: ${config.support}`)
      .catch(() => {});
  });
}

import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { config, TERMS } from "@/lib/config";
import { query, queryOne } from "@/lib/db";
import { getState, setState } from "@/lib/state";
import { esc, fmt, normalizeDigits, show, uid } from "../helpers";
import { backKb, mainMenu } from "../keyboards";

export function registerWallet(bot: Bot<BotContext>) {
  // ── حساب کاربری ───────────────────────────────────────────
  bot.callbackQuery("account", async (ctx) => {
    const u = await queryOne<{ id: number; balance: number; created_at: Date }>(
      "SELECT id, balance, created_at FROM users WHERE id=$1",
      [uid(ctx)],
    );
    const n = await queryOne<{ n: number }>(
      "SELECT count(*)::int AS n FROM services WHERE user_id=$1 AND status='active'",
      [uid(ctx)],
    );
    if (!u) return;
    await show(
      ctx,
      `👤 <b>حساب کاربری</b>\n\nآیدی عددی: <code>${u.id}</code>\n` +
        `موجودی: <b>${fmt(u.balance)}</b> تومان\nسرورهای فعال: ${n?.n ?? 0}\n` +
        `تاریخ عضویت: ${u.created_at.toISOString().slice(0, 10)}`,
      backKb([["💳 شارژ حساب", "topup"]]),
    );
  });

  // ── پشتیبانی / قوانین ─────────────────────────────────────
  bot.callbackQuery("support", (ctx) =>
    show(ctx, `🆘 برای ارتباط با پشتیبانی پیام دهید:\n${esc(config.support)}`, backKb()),
  );
  bot.callbackQuery("terms", (ctx) => show(ctx, TERMS, backKb()));

  // ── درآمدزایی ─────────────────────────────────────────────
  bot.callbackQuery("referral", async (ctx) => {
    const id = uid(ctx);
    const stats = await queryOne<{ cnt: number; earn: number }>(
      `SELECT (SELECT count(*)::int FROM users WHERE referrer_id=$1) AS cnt,
              (SELECT COALESCE(sum(amount),0)::bigint FROM referral_earnings WHERE referrer_id=$1) AS earn`,
      [id],
    );
    await show(
      ctx,
      `💰 <b>درآمدزایی</b>\n\nبا دعوت دوستان، <b>${config.refPercent}%</b> از هر شارژ آن‌ها به‌صورت دائمی به کیف پول شما اضافه می‌شود.\n\n` +
        `🔗 لینک شما:\n<code>https://t.me/${ctx.me.username}?start=ref_${id}</code>\n\n` +
        `👥 زیرمجموعه‌ها: ${stats?.cnt ?? 0}\n💵 درآمد کل: ${fmt(stats?.earn ?? 0)} تومان`,
      backKb(),
    );
  });

  // ── شارژ حساب ─────────────────────────────────────────────
  bot.callbackQuery("topup", async (ctx) => {
    await setState(uid(ctx), "topup_amount");
    await show(
      ctx,
      `💳 مبلغ شارژ را به <b>تومان</b> و به‌صورت عدد بفرستید (حداقل ${fmt(config.minTopup)}):`,
      backKb(),
    );
  });

  bot.on("message:text", async (ctx) => {
    const st = await getState(uid(ctx));
    if (st.state !== "topup_amount") return;

    const txt = normalizeDigits(ctx.message.text);
    if (!/^\d+$/.test(txt) || Number(txt) < config.minTopup) {
      return void ctx.reply(`❌ یک عدد معتبر (حداقل ${fmt(config.minTopup)}) بفرستید.`);
    }
    const amount = Number(txt);
    await setState(uid(ctx), "topup_receipt", { amount });
    await ctx.reply(
      `مبلغ <b>${fmt(amount)}</b> تومان را به کارت زیر واریز کنید:\n\n` +
        `<code>${esc(config.cardNumber)}</code>\nبه نام: ${esc(config.cardOwner)}\n\n` +
        `سپس <b>عکس رسید</b> را همین‌جا بفرستید.`,
      { parse_mode: "HTML", reply_markup: backKb() },
    );
  });

  bot.on("message:photo", async (ctx) => {
    const id = uid(ctx);
    const st = await getState(id);
    if (st.state !== "topup_receipt") return;

    const amount = Number(st.data?.amount);
    if (!Number.isFinite(amount) || amount <= 0) return setState(id, null);

    const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    const pay = await queryOne<{ id: number }>(
      "INSERT INTO payments (user_id, amount, receipt_file_id) VALUES ($1,$2,$3) RETURNING id",
      [id, amount, fileId],
    );
    await setState(id, null);
    await ctx.reply("✅ رسید ثبت شد. پس از تأیید ادمین، حساب شما شارژ می‌شود.", { reply_markup: mainMenu() });

    const kb = new InlineKeyboard().text("✅ تأیید", `payok:${pay!.id}`).text("❌ رد", `payno:${pay!.id}`);
    for (const admin of config.admins) {
      await ctx.api
        .sendPhoto(admin, fileId, {
          caption:
            `💳 پرداخت #${pay!.id}\nکاربر: <code>${id}</code> (@${esc(ctx.from?.username)})\n` +
            `مبلغ: ${fmt(amount)} تومان`,
          parse_mode: "HTML",
          reply_markup: kb,
        })
        .catch((e) => console.error("notify admin failed", e));
    }
  });
}

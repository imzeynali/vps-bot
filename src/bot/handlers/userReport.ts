import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { config } from "@/lib/config";
import { queryOne } from "@/lib/db";
import { getState, setState } from "@/lib/state";
import { codes, esc, getGroup, payerInfo, report, stamp } from "@/lib/adminGroup";
import { show, uid } from "../helpers";
import { backKb } from "../keyboards";

/** کاربر از «تماس با پشتیبانی» گزارش می‌فرستد ← تاپیک «پیگیری» در گروه مدیریتی (یا پیام خصوصی به ادمین‌ها) */
export function registerUserReport(bot: Bot<BotContext>) {
  bot.callbackQuery("urep", async (ctx) => {
    await setState(uid(ctx), "urep_wait");
    await show(
      ctx,
      "📝 <b>ارسال گزارش به پشتیبانی</b>\n\nمشکل یا درخواست خود را بنویسید (می‌توانید عکس هم بفرستید). شماره‌ی سرور را هم ذکر کنید.",
      new InlineKeyboard().text("❌ انصراف", "home"),
    );
  });

  bot.on("message", async (ctx, next) => {
    if (ctx.chat.type !== "private") return next();
    const st = await getState(uid(ctx));
    if (st.state !== "urep_wait") return next();
    if (ctx.message.text?.startsWith("/")) return next();
    if (ctx.message.media_group_id) return void ctx.reply("❌ آلبوم پشتیبانی نمی‌شود؛ یک پیام (متن یا تک‌عکس) بفرستید.");

    const row = await queryOne<{ id: number }>("INSERT INTO user_reports (user_id) VALUES ($1) RETURNING id", [uid(ctx)]);
    const code = codes.report(row!.id);
    await setState(uid(ctx), null);

    const header =
      `📨 <b>گزارش کاربر</b> — کد <code>${code}</code>\n🕒 ${stamp()}\n` + (await payerInfo(uid(ctx)));

    const g = await getGroup();
    let delivered = false;
    if (g.chatId && g.topics.followup) {
      delivered = await report(ctx.api, "followup", header);
      await ctx.api
        .copyMessage(g.chatId, ctx.chat.id, ctx.message.message_id, { message_thread_id: g.topics.followup })
        .catch((e) => console.error("copy report failed", e));
    }
    if (!delivered) {
      for (const a of config.admins) {
        await ctx.api.sendMessage(a, header, { parse_mode: "HTML" }).catch(() => {});
        await ctx.api.copyMessage(a, ctx.chat.id, ctx.message.message_id).catch(() => {});
      }
    }
    await ctx.reply(`✅ گزارش شما ثبت شد.\nکد پیگیری: <code>${esc(code)}</code>\nپشتیبانی در اسرع وقت بررسی می‌کند.`, {
      parse_mode: "HTML",
      reply_markup: backKb(),
    });
  });
}

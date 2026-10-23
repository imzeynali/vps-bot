import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { query } from "@/lib/db";
import { setState } from "@/lib/state";
import { mainMenu } from "../keyboards";
import { show, uid } from "../helpers";

export function registerStart(bot: Bot<BotContext>) {
  bot.command("start", async (ctx) => {
    const id = uid(ctx);
    await setState(id, null);

    const arg = typeof ctx.match === "string" ? ctx.match : "";
    if (ctx.isNewUser && arg.startsWith("ref_")) {
      const ref = Number(arg.slice(4));
      if (Number.isInteger(ref) && ref !== id) {
        await query(
          "UPDATE users SET referrer_id=$1 WHERE id=$2 AND EXISTS (SELECT 1 FROM users WHERE id=$1)",
          [ref, id],
        );
      }
    }

    await ctx.reply("👋 به ربات فروش سرور مجازی ایران خوش آمدید.\nپرداخت به‌صورت <b>ساعتی</b> است.", {
      parse_mode: "HTML",
      reply_markup: mainMenu(),
    });
  });

  bot.callbackQuery("home", async (ctx) => {
    await setState(uid(ctx), null);
    await show(ctx, "🏠 منوی اصلی:", mainMenu());
  });
}

import { Bot } from "grammy";
import type { BotContext } from "./context";
import { config } from "@/lib/config";
import { queryOne } from "@/lib/db";
import { registerStart } from "./handlers/start";
import { registerBuy } from "./handlers/buy";
import { registerServices } from "./handlers/services";
import { registerWallet } from "./handlers/wallet";
import { registerAdmin } from "./handlers/admin";

const g = globalThis as unknown as { __bot?: Bot<BotContext> };

function createBot(): Bot<BotContext> {
  if (!config.botToken) throw new Error("BOT_TOKEN تنظیم نشده است");
  const bot = new Bot<BotContext>(config.botToken);

  // ثبت/به‌روزرسانی کاربر در هر آپدیت
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      const row = await queryOne<{ inserted: boolean }>(
        `INSERT INTO users (id, username) VALUES ($1,$2)
         ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username
         RETURNING (xmax = 0) AS inserted`,
        [ctx.from.id, ctx.from.username ?? null],
      );
      ctx.isNewUser = row?.inserted ?? false;
    }
    await next();
  });

  registerStart(bot);
  registerAdmin(bot);
  registerBuy(bot);
  registerServices(bot);
  registerWallet(bot); // شامل message:text و message:photo؛ آخر ثبت شود

  bot.catch((err) => console.error("bot error:", err.error));
  return bot;
}

export function getBot(): Bot<BotContext> {
  return (g.__bot ??= createBot());
}

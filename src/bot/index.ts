import { Bot } from "grammy";
import type { BotContext } from "./context";
import { config } from "@/lib/config";
import { queryOne } from "@/lib/db";
import { esc, reportError, stamp } from "@/lib/adminGroup";
import { registerStart } from "./handlers/start";
import { registerBuy } from "./handlers/buy";
import { registerBuyCgi } from "./handlers/buyCgi";
import { registerServices } from "./handlers/services";
import { registerWallet } from "./handlers/wallet";
import { registerAdmin } from "./handlers/admin";
import { registerAdminVirt } from "./handlers/adminVirt";
import { registerAdminCatalog } from "./handlers/adminCatalog";
import { registerAdminPanel } from "./handlers/adminPanel";
import { registerAdminGroup } from "./handlers/adminGroup";
import { registerAdminDatacenters } from "./handlers/adminDatacenters";
import { registerAdminBandwidth } from "./handlers/adminBandwidth";
import { registerUserReport } from "./handlers/userReport";

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
  registerAdminVirt(bot); // قبل از registerAdminPanel (فالبک adm:*)
  registerAdminCatalog(bot); // پلن/لوکیشن/OS/تنظیمات از داخل پنل ادمین
  registerAdminBandwidth(bot); // قیمت پهنای باند CGI (/bw /setbw)
  registerAdminDatacenters(bot); // مدیریت دیتاسنترها (قبل از فالبک adm:*)
  registerAdminGroup(bot); // گروه مدیریتی (قبل از فالبک adm:*)
  registerUserReport(bot); // گزارش کاربران ← تاپیک پیگیری
  registerAdminPanel(bot); // باید قبل از registerWallet باشد (پیام همگانی)
  registerBuyCgi(bot); // جریان اختصاصی CGI (باید قبل از buy باشد تا dc:cgi را بگیرد)
  registerBuy(bot);
  registerServices(bot);
  registerWallet(bot); // شامل message:text و message:photo؛ آخر ثبت شود

  bot.catch((err) => {
    console.error("bot error:", err.error);
    const m = err.error instanceof Error ? err.error.message : String(err.error);
    void reportError(bot.api, `🚨 <b>خطای ربات</b>\n🕒 ${stamp()}\n<code>${esc(m).slice(0, 600)}</code>`);
  });
  return bot;
}

export function getBot(): Bot<BotContext> {
  return (g.__bot ??= createBot());
}

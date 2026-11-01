import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { config } from "@/lib/config";
import { setState } from "@/lib/state";
import { TOPICS, disconnectGroup, getGroup, report, setupGroup, stamp } from "@/lib/adminGroup";
import type { Topic } from "@/lib/adminGroup";
import { sendServerReport } from "@/lib/serverReport";
import { alert, show, uid } from "../helpers";

const isAdmin = (ctx: BotContext) => !!ctx.from && config.admins.includes(ctx.from.id);

async function panelText() {
  const g = await getGroup();
  const head = "👥 <b>تنظیم گروه مدیریتی</b>\n\n";
  if (!g.chatId) {
    return (
      head +
      "هنوز گروهی متصل نشده است.\n\n" +
      "<b>مراحل:</b>\n" +
      "1️⃣ یک <b>سوپرگروه</b> بسازید و در تنظیمات آن گزینه‌ی <b>Topics</b> را روشن کنید.\n" +
      "2️⃣ ربات را به گروه اضافه و <b>ادمین</b> کنید (دسترسی <b>Manage Topics</b> لازم است).\n" +
      "3️⃣ داخل همان گروه دستور <code>/setgroup</code> را بفرستید.\n\n" +
      "تاپیک‌های 💰 مالی، 🖥 سرورها، 🚨 خطا و 📨 پیگیری خودکار ساخته می‌شوند."
    );
  }
  const rows = (Object.keys(TOPICS) as Topic[])
    .map((t) => `${TOPICS[t].icon} ${TOPICS[t].title}: ${g.topics[t] ? "✅" : "❌ ساخته نشده"}`)
    .join("\n");
  return head + `✅ متصل است\n🆔 گروه: <code>${g.chatId}</code>\n\n${rows}`;
}

async function panelKb() {
  const g = await getGroup();
  const kb = new InlineKeyboard();
  if (g.chatId) {
    kb.text("🧪 ارسال پیام تست", "adm:grp:test").text("🖥 گزارش سرورها", "adm:grp:rep").row();
    kb.text("🔄 ساخت تاپیک‌های ناقص", "adm:grp:fix").row();
    kb.text("❌ قطع اتصال گروه", "adm:grp:off").row();
  }
  return kb.text("🔄 بروزرسانی", "adm:grp").row().text("🔙 پنل مدیریت", "admin");
}

export function registerAdminGroup(bot: Bot<BotContext>) {
  // ── دکمه‌ی پنل مدیریت ──
  bot.callbackQuery("adm:grp", async (ctx) => {
    if (!isAdmin(ctx)) return alert(ctx, "دسترسی ندارید");
    await setState(uid(ctx), null);
    await show(ctx, await panelText(), await panelKb());
  });

  // ── اتصال: داخل گروه /setgroup  (یا در خصوصی: /setgroup <chat_id>) ──
  bot.command("setgroup", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const arg = ctx.match.trim();
    let chatId: number;
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") chatId = ctx.chat.id;
    else if (/^-100\d{5,}$/.test(arg)) chatId = Number(arg);
    else {
      return void ctx.reply(
        "این دستور را باید <b>داخل گروه</b> بفرستید.\n(یا در اینجا: <code>/setgroup -100xxxxxxxxxx</code>)",
        { parse_mode: "HTML" },
      );
    }
    const r = await setupGroup(ctx.api, chatId);
    if (!r.ok) return void ctx.reply("❌ " + r.error).catch(() => {});
    await report(ctx.api, "finance", `✅ <b>گروه مدیریتی متصل شد</b>\n🕒 ${stamp()}\nگزارش تراکنش‌های مالی در این تاپیک ارسال می‌شود.`);
    await report(ctx.api, "servers", `✅ گزارش وضعیت سرورها هر ۶ ساعت در این تاپیک ارسال می‌شود.`);
    await report(ctx.api, "errors", `✅ خطاها و مشکلات سرورها در این تاپیک گزارش می‌شوند.`);
    await report(ctx.api, "followup", `✅ گزارش‌های کاربران و درخواست‌های پیگیری در این تاپیک ثبت می‌شوند.`);
    if (ctx.chat.type !== "private") {
      await ctx.api.sendMessage(ctx.from!.id, "✅ گروه مدیریتی متصل شد و تاپیک‌ها ساخته شدند.", { reply_markup: await panelKb() }).catch(() => {});
    } else {
      await ctx.reply("✅ گروه متصل شد.", { reply_markup: await panelKb() });
    }
  });

  bot.callbackQuery("adm:grp:test", async (ctx) => {
    if (!isAdmin(ctx)) return alert(ctx, "دسترسی ندارید");
    let okCount = 0;
    for (const t of Object.keys(TOPICS) as Topic[]) {
      if (await report(ctx.api, t, `🧪 پیام تست — ${stamp()}`)) okCount++;
    }
    await alert(ctx, okCount === 4 ? "✅ پیام تست در هر ۴ تاپیک ارسال شد" : `فقط ${okCount} از ۴ تاپیک ارسال شد؛ «ساخت تاپیک‌های ناقص» را بزنید`);
  });

  bot.callbackQuery("adm:grp:rep", async (ctx) => {
    if (!isAdmin(ctx)) return alert(ctx, "دسترسی ندارید");
    await alert(ctx, "⏳ بررسی شروع شد؛ گزارش تا چند دقیقه‌ی دیگر در تاپیک سرورها ارسال می‌شود.");
    void sendServerReport(ctx.api).catch((e) => console.error("server report failed", e));
  });

  bot.callbackQuery("adm:grp:fix", async (ctx) => {
    if (!isAdmin(ctx)) return alert(ctx, "دسترسی ندارید");
    const g = await getGroup();
    if (!g.chatId) return alert(ctx, "گروهی متصل نیست");
    const r = await setupGroup(ctx.api, g.chatId);
    if (!r.ok) return alert(ctx, r.error);
    await show(ctx, await panelText(), await panelKb(), "✅ انجام شد");
  });

  bot.callbackQuery("adm:grp:off", async (ctx) => {
    if (!isAdmin(ctx)) return alert(ctx, "دسترسی ندارید");
    await show(
      ctx,
      "❌ اتصال گروه قطع شود؟\nگزارش‌ها دیگر به گروه ارسال نمی‌شوند (خطاها به پیام خصوصی ادمین‌ها برمی‌گردند). تاپیک‌ها در گروه پاک نمی‌شوند.",
      new InlineKeyboard().text("✅ بله، قطع شود", "adm:grp:off2").text("↩️ انصراف", "adm:grp"),
    );
  });
  bot.callbackQuery("adm:grp:off2", async (ctx) => {
    if (!isAdmin(ctx)) return alert(ctx, "دسترسی ندارید");
    await disconnectGroup();
    await show(ctx, await panelText(), await panelKb(), "قطع شد");
  });

}

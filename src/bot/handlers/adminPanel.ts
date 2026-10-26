import { GrammyError, InlineKeyboard } from "grammy";
import type { Api, Bot } from "grammy";
import type { BotContext } from "../context";
import { config } from "@/lib/config";
import { query, queryOne } from "@/lib/db";
import { getState, setState } from "@/lib/state";
import { alert, esc, fmt, show, uid } from "../helpers";

const PAGE_SIZE = 10;
const TZ = "Asia/Tehran";

const isAdmin = (ctx: BotContext) => !!ctx.from && config.admins.includes(ctx.from.id);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jdate = (d: Date) => new Date(d).toLocaleDateString("fa-IR", { timeZone: TZ });

// ───────────────────────── پنل اصلی ─────────────────────────
const PANEL_TEXT = "🛠 <b>پنل مدیریت</b>\n\nیکی از گزینه‌ها را انتخاب کنید:";

const panelKb = () =>
  new InlineKeyboard()
    .text("👥 مدیریت کاربران", "adm:users:1")
    .text("📊 آمار ربات", "adm:stats")
    .row()
    .text("📢 ارسال پیام همگانی", "adm:bc")
    .row()
    .text("🔙 منوی اصلی", "home");

const toPanelKb = () => new InlineKeyboard().text("🔙 پنل مدیریت", "admin");

// ───────────────────────── لیست کاربران ─────────────────────────
async function usersPage(ctx: BotContext, requested: number) {
  const total = (await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM users"))?.n ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, requested), pages);

  const rows = await query<{
    id: number;
    username: string | null;
    balance: number;
    created_at: Date;
    active_services: number;
  }>(
    `SELECT u.id, u.username, u.balance, u.created_at,
            (SELECT count(*)::int FROM services s WHERE s.user_id = u.id AND s.status = 'active') AS active_services
     FROM users u
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT $1 OFFSET $2`,
    [PAGE_SIZE, (page - 1) * PAGE_SIZE],
  );

  let text = `👥 <b>لیست کاربران</b> (کل: ${fmt(total)})\n\n`;
  if (rows.length === 0) text += "کاربری وجود ندارد.";
  rows.forEach((u, i) => {
    const n = (page - 1) * PAGE_SIZE + i + 1;
    text +=
      `<b>${n}.</b> <code>${u.id}</code> — ${u.username ? "@" + esc(u.username) : "بدون یوزرنیم"}\n` +
      `    💰 ${fmt(u.balance)} ت | 🖥 ${u.active_services} سرور فعال | 📅 ${jdate(u.created_at)}\n`;
  });

  const kb = new InlineKeyboard();
  if (page > 1) kb.text("⬅️ قبلی", `adm:users:${page - 1}`);
  kb.text(`${page} / ${pages}`, "adm:noop");
  if (page < pages) kb.text("بعدی ➡️", `adm:users:${page + 1}`);
  kb.row().text("🔙 پنل مدیریت", "admin");

  await show(ctx, text, kb);
}

// ───────────────────────── آمار ربات ─────────────────────────
async function statsText() {
  const s = await queryOne<Record<string, number>>(
    `WITH t AS (SELECT date_trunc('day', now() AT TIME ZONE '${TZ}') AT TIME ZONE '${TZ}' AS d)
     SELECT
       (SELECT count(*) FROM users)::int AS users_total,
       (SELECT count(*) FROM users, t WHERE users.created_at >= t.d)::int AS users_today,
       (SELECT count(*) FROM users WHERE created_at >= now() - interval '7 days')::int AS users_7d,
       (SELECT count(*) FROM users WHERE created_at >= now() - interval '30 days')::int AS users_30d,

       (SELECT COALESCE(sum(amount),0) FROM payments, t WHERE status='approved' AND approved_at >= t.d)::bigint AS sales_today,
       (SELECT COALESCE(sum(amount),0) FROM payments WHERE status='approved' AND approved_at >= now() - interval '7 days')::bigint AS sales_7d,
       (SELECT COALESCE(sum(amount),0) FROM payments WHERE status='approved' AND approved_at >= now() - interval '30 days')::bigint AS sales_30d,
       (SELECT COALESCE(sum(amount),0) FROM payments WHERE status='approved')::bigint AS sales_total,

       (SELECT count(*) FROM services, t WHERE services.created_at >= t.d)::int AS sold_today,
       (SELECT count(*) FROM services WHERE created_at >= now() - interval '7 days')::int AS sold_7d,
       (SELECT count(*) FROM services WHERE created_at >= now() - interval '30 days')::int AS sold_30d,
       (SELECT count(*) FROM services)::int AS sold_total,

       (SELECT count(*) FROM services WHERE status='active')::int AS svc_active,
       (SELECT count(*) FROM services WHERE status='active' AND power='on')::int AS svc_on,
       (SELECT count(*) FROM services WHERE status='active' AND power='off')::int AS svc_off,
       (SELECT count(*) FROM services WHERE status='suspended')::int AS svc_suspended,
       (SELECT count(*) FROM services WHERE status='deleted')::int AS svc_deleted`,
  );
  if (!s) return "خطا در دریافت آمار";

  const time = new Date().toLocaleTimeString("en-GB", { timeZone: TZ });
  return (
    `📊 <b>آمار ربات</b>\n\n` +
    `💰 <b>آمار فروش</b> (شارژهای تأییدشده)\n` +
    `امروز: <b>${fmt(s.sales_today)}</b> تومان\n` +
    `۷ روز اخیر: <b>${fmt(s.sales_7d)}</b> تومان\n` +
    `۳۰ روز اخیر: <b>${fmt(s.sales_30d)}</b> تومان\n` +
    `کل: <b>${fmt(s.sales_total)}</b> تومان\n\n` +
    `🛒 <b>سرویس‌های فروخته‌شده</b>\n` +
    `امروز: ${fmt(s.sold_today)} | ۷ روز: ${fmt(s.sold_7d)} | ۳۰ روز: ${fmt(s.sold_30d)} | کل: ${fmt(s.sold_total)}\n\n` +
    `👥 <b>کاربران</b>\n` +
    `جدید امروز: ${fmt(s.users_today)}\n` +
    `جدید ۷ روز اخیر: ${fmt(s.users_7d)}\n` +
    `جدید ۳۰ روز اخیر: ${fmt(s.users_30d)}\n` +
    `تعداد کل کاربران: <b>${fmt(s.users_total)}</b>\n\n` +
    `🖥 <b>سرورها</b>\n` +
    `🟢 فعال: <b>${fmt(s.svc_active)}</b> (روشن: ${fmt(s.svc_on)} | خاموش: ${fmt(s.svc_off)})\n` +
    `🔴 غیرفعال: <b>${fmt(s.svc_suspended + s.svc_deleted)}</b> (متوقف‌شده: ${fmt(s.svc_suspended)} | حذف‌شده: ${fmt(s.svc_deleted)})\n\n` +
    `🕒 «امروز» از ساعت ۰۰:۰۰ به وقت تهران | بروزرسانی: ${time}`
  );
}

// ───────────────────────── پیام همگانی ─────────────────────────
type SendResult = "ok" | "blocked" | "failed";

async function copyWithRetry(api: Api, to: number, fromChat: number, messageId: number): Promise<SendResult> {
  for (let i = 0; i < 3; i++) {
    try {
      await api.copyMessage(to, fromChat, messageId);
      return "ok";
    } catch (e) {
      if (e instanceof GrammyError) {
        if (e.error_code === 429) {
          await sleep(((e.parameters.retry_after ?? 1) + 1) * 1000);
          continue;
        }
        if (e.error_code === 403) return "blocked"; // کاربر ربات را بلاک کرده
      }
      return "failed";
    }
  }
  return "failed";
}

const g = globalThis as unknown as { __broadcasting?: boolean };

async function runBroadcast(api: Api, adminId: number, fromChat: number, messageId: number) {
  const users = await query<{ id: number }>("SELECT id FROM users ORDER BY id");
  let ok = 0;
  let blocked = 0;
  let failed = 0;

  for (const { id } of users) {
    const r = await copyWithRetry(api, id, fromChat, messageId);
    if (r === "ok") ok++;
    else if (r === "blocked") blocked++;
    else failed++;
    await sleep(50); // حدود ۲۰ پیام در ثانیه (محدودیت تلگرام ~۳۰)
  }

  await api
    .sendMessage(
      adminId,
      `📢 <b>ارسال پیام همگانی تمام شد</b>\n\n` +
        `👥 کل کاربران: ${fmt(users.length)}\n✅ موفق: ${fmt(ok)}\n🚫 بلاک‌کرده: ${fmt(blocked)}\n❌ ناموفق: ${fmt(failed)}`,
      { parse_mode: "HTML", reply_markup: toPanelKb() },
    )
    .catch(() => {});
}

// ───────────────────────── ثبت هندلرها ─────────────────────────
export function registerAdminPanel(bot: Bot<BotContext>) {
  const adm = bot.filter(isAdmin);

  adm.command("admin", async (ctx) => {
    await setState(uid(ctx), null);
    await ctx.reply(PANEL_TEXT, { parse_mode: "HTML", reply_markup: panelKb() });
  });

  adm.callbackQuery("admin", async (ctx) => {
    await setState(uid(ctx), null);
    await show(ctx, PANEL_TEXT, panelKb());
  });

  adm.callbackQuery("adm:noop", (ctx) => ctx.answerCallbackQuery());

  // ── مدیریت کاربران ──
  adm.callbackQuery(/^adm:users:(\d+)$/, async (ctx) => {
    await usersPage(ctx, Number(ctx.match[1]));
  });

  // ── آمار ──
  adm.callbackQuery("adm:stats", async (ctx) => {
    const kb = new InlineKeyboard().text("🔄 بروزرسانی", "adm:stats").row().text("🔙 پنل مدیریت", "admin");
    await show(ctx, await statsText(), kb);
  });

  // ── پیام همگانی: ۱) دریافت پیام ۲) پیش‌نمایش و تأیید ۳) ارسال ──
  adm.callbackQuery("adm:bc", async (ctx) => {
    await setState(uid(ctx), "bc_wait");
    await show(
      ctx,
      "📢 <b>ارسال پیام همگانی</b>\n\nپیام خود را بفرستید (متن، عکس، ویدیو، فایل و ...).\nهمان پیام برای تمام کاربران ارسال می‌شود.",
      new InlineKeyboard().text("❌ انصراف", "adm:bcx"),
    );
  });

  adm.callbackQuery("adm:bcx", async (ctx) => {
    await setState(uid(ctx), null);
    await show(ctx, PANEL_TEXT, panelKb(), "لغو شد");
  });

  adm.on("message", async (ctx, next) => {
    const st = await getState(uid(ctx));
    if (st.state !== "bc_wait" && st.state !== "bc_confirm") return next();
    if (ctx.message.text?.startsWith("/")) return next(); // دستورها کار خودشان را بکنند
    if (ctx.message.media_group_id) {
      return void ctx.reply("❌ آلبوم پشتیبانی نمی‌شود؛ فقط یک پیام (تک عکس/ویدیو/متن) بفرستید.");
    }

    const total = (await queryOne<{ n: number }>("SELECT count(*)::int AS n FROM users"))?.n ?? 0;
    await setState(uid(ctx), "bc_confirm", { chatId: ctx.chat.id, messageId: ctx.message.message_id });

    await ctx.api.copyMessage(ctx.chat.id, ctx.chat.id, ctx.message.message_id); // پیش‌نمایش
    await ctx.reply(`⬆️ پیش‌نمایش پیام بالا.\n\nبه <b>${fmt(total)}</b> کاربر ارسال شود؟`, {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard()
        .text("✅ ارسال برای همه", "adm:bcgo")
        .row()
        .text("❌ انصراف", "adm:bcx"),
    });
  });

  adm.callbackQuery("adm:bcgo", async (ctx) => {
    // state را اتمیک پاک می‌کنیم تا با دوبار کلیک، دوبار ارسال نشود
    const row = await queryOne<{ data: { chatId: number; messageId: number } | null }>(
      `WITH old AS (SELECT state_data FROM users WHERE id=$1 AND state='bc_confirm' FOR UPDATE)
       UPDATE users SET state=NULL, state_data=NULL FROM old
       WHERE users.id=$1 RETURNING old.state_data AS data`,
      [uid(ctx)],
    );
    if (!row?.data) return alert(ctx, "پیامی برای ارسال وجود ندارد. دوباره شروع کنید.");
    if (g.__broadcasting) return alert(ctx, "یک ارسال همگانی در حال انجام است. تا پایان آن صبر کنید.");

    g.__broadcasting = true;
    const { chatId, messageId } = row.data;
    // پس‌زمینه اجرا می‌شود تا وبهوک تلگرام معطل نماند (نیازمند سرور دائمی: next start)
    void runBroadcast(ctx.api, uid(ctx), chatId, messageId)
      .catch((e) => console.error("broadcast error", e))
      .finally(() => {
        g.__broadcasting = false;
      });

    await show(ctx, "🚀 ارسال همگانی شروع شد. پس از پایان، گزارش برای شما ارسال می‌شود.", toPanelKb());
  });

  // غیرادمین‌ها
  bot.callbackQuery(/^adm:/, (ctx) => alert(ctx, "دسترسی ندارید"));
  bot.callbackQuery("admin", (ctx) => alert(ctx, "دسترسی ندارید"));
}

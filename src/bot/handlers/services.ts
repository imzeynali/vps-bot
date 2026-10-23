import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { OS_LIST } from "@/lib/config";
import { query, queryOne } from "@/lib/db";
import { deleteServer, powerAction, rebuildServer } from "@/lib/provider";
import type { PowerAction } from "@/lib/provider";
import type { ServiceRow } from "@/lib/types";
import { alert, esc, fmt, show, uid } from "../helpers";
import { backKb } from "../keyboards";

const SELECT = `
  SELECT s.*, p.name AS plan_name, p.cpu, p.ram_gb, p.disk_gb
  FROM services s JOIN plans p ON p.id = s.plan_id`;

/** فقط سرورِ «فعال» متعلق به همین کاربر */
const getOwnActive = (userId: number, id: number) =>
  queryOne<ServiceRow>(`${SELECT} WHERE s.id=$1 AND s.user_id=$2 AND s.status='active'`, [id, userId]);

function serviceKb(id: number) {
  return new InlineKeyboard()
    .text("▶️ روشن", `pw:${id}:on`)
    .text("⏹ خاموش", `pw:${id}:off`)
    .row()
    .text("🔄 ریبوت", `pw:${id}:reboot`)
    .text("🛠 ریبیلد", `rb:${id}`)
    .row()
    .text("🗑 حذف سرور", `del:${id}`)
    .row()
    .text("⬅️ سرویس‌های من", "services")
    .text("🔙 منوی اصلی", "home");
}

function serviceText(s: ServiceRow) {
  return (
    `🖥 <b>سرور #${s.id}</b> — ${esc(s.plan_name)}\n` +
    `وضعیت: ${s.power === "on" ? "🟢 روشن" : "🔴 خاموش"}\n\n` +
    `🌍 لوکیشن: ${esc(s.location)}\n` +
    `💿 سیستم‌عامل: ${esc(s.os)}\n` +
    `⚙️ مشخصات: ${s.cpu}C / ${s.ram_gb}G / ${s.disk_gb}G\n\n` +
    `🌐 IP: <code>${esc(s.ip)}</code>\n` +
    `👤 یوزر: <code>${esc(s.login_user)}</code>\n` +
    `🔑 پسورد: <code>${esc(s.login_pass)}</code>\n\n` +
    `💵 هزینه: ${fmt(s.hourly_price)} تومان در ساعت`
  );
}

async function showService(ctx: BotContext, id: number, toast?: string) {
  const s = await getOwnActive(uid(ctx), id);
  if (!s) return alert(ctx, "این سرور فعال نیست یا یافت نشد.");
  await show(ctx, serviceText(s), serviceKb(id), toast);
}

const POWER_TOAST: Record<PowerAction, string> = {
  on: "✅ سرور روشن شد",
  off: "✅ سرور خاموش شد",
  reboot: "✅ سرور ریبوت شد",
};

export function registerServices(bot: Bot<BotContext>) {
  // ── سرویس‌های من ──────────────────────────────────────────
  bot.callbackQuery("services", async (ctx) => {
    const rows = await query<{ id: number; plan_name: string; power: string; ip: string | null }>(
      `SELECT s.id, p.name AS plan_name, s.power, s.ip
       FROM services s JOIN plans p ON p.id = s.plan_id
       WHERE s.user_id=$1 AND s.status='active' ORDER BY s.id DESC`,
      [uid(ctx)],
    );

    // سرور فعالی ندارد
    if (rows.length === 0) {
      return show(
        ctx,
        "❌ <b>شما سرور فعالی ندارید.</b>\n\nبرای شروع، یک سرور بخرید.",
        backKb([["🛒 خرید سرویس", "buy"]]),
      );
    }

    // فقط یک سرور فعال: مستقیم مشخصات و دکمه‌های مدیریت
    if (rows.length === 1) return showService(ctx, rows[0].id);

    // چند سرور فعال: لیست
    const kb = new InlineKeyboard();
    for (const r of rows) {
      kb.text(`${r.power === "on" ? "🟢" : "🔴"} #${r.id} - ${r.plan_name} - ${r.ip ?? ""}`, `svc:${r.id}`).row();
    }
    kb.text("🔙 منوی اصلی", "home");
    await show(ctx, "📦 <b>سرورهای فعال شما:</b>", kb);
  });

  bot.callbackQuery(/^svc:(\d+)$/, (ctx) => showService(ctx, Number(ctx.match[1])));

  // ── روشن / خاموش / ریبوت ──────────────────────────────────
  bot.callbackQuery(/^pw:(\d+):(on|off|reboot)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const action = ctx.match[2] as PowerAction;
    const s = await getOwnActive(uid(ctx), id);
    if (!s) return alert(ctx, "این سرور فعال نیست یا یافت نشد.");

    if (action === "on" && s.power === "on") return alert(ctx, "سرور از قبل روشن است.");
    if (action === "off" && s.power === "off") return alert(ctx, "سرور از قبل خاموش است.");
    if (action === "reboot" && s.power === "off") return alert(ctx, "سرور خاموش است؛ ابتدا آن را روشن کنید.");

    try {
      await powerAction(id, action);
    } catch (e) {
      console.error("power action failed", e);
      return alert(ctx, "❌ خطا در ارتباط با سرور. چند لحظه بعد دوباره تلاش کنید.");
    }
    if (action !== "reboot") {
      await query("UPDATE services SET power=$1 WHERE id=$2", [action, id]);
    }
    await showService(ctx, id, POWER_TOAST[action]);
  });

  // ── ریبیلد: انتخاب سیستم‌عامل ← تأیید ← اجرا ───────────────
  bot.callbackQuery(/^rb:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    if (!(await getOwnActive(uid(ctx), id))) return alert(ctx, "این سرور فعال نیست یا یافت نشد.");
    const kb = new InlineKeyboard();
    for (const [key, title] of Object.entries(OS_LIST)) kb.text(`🐧 ${title}`, `rbo:${id}:${key}`).row();
    kb.text("❌ انصراف", `svc:${id}`);
    await show(ctx, `🛠 <b>ریبیلد سرور #${id}</b>\n\nسیستم‌عامل جدید را انتخاب کنید:`, kb);
  });

  bot.callbackQuery(/^rbo:(\d+):(\w+)$/, async (ctx) => {
    const [, id, os] = ctx.match;
    if (!OS_LIST[os]) return alert(ctx, "سیستم‌عامل نامعتبر");
    if (!(await getOwnActive(uid(ctx), Number(id)))) return alert(ctx, "این سرور فعال نیست یا یافت نشد.");
    const kb = new InlineKeyboard()
      .text("✅ بله، ریبیلد شود", `rbc:${id}:${os}`)
      .row()
      .text("❌ انصراف", `svc:${id}`);
    await show(
      ctx,
      `⚠️ با ریبیلد، <b>تمام اطلاعات سرور #${id} پاک</b> و ${OS_LIST[os]} نصب می‌شود. پسورد جدید ساخته خواهد شد.\n\nادامه می‌دهید؟`,
      kb,
    );
  });

  bot.callbackQuery(/^rbc:(\d+):(\w+)$/, async (ctx) => {
    const [, idStr, os] = ctx.match;
    const id = Number(idStr);
    if (!OS_LIST[os]) return alert(ctx, "سیستم‌عامل نامعتبر");
    if (!(await getOwnActive(uid(ctx), id))) return alert(ctx, "این سرور فعال نیست یا یافت نشد.");

    try {
      const { password } = await rebuildServer(id, OS_LIST[os]);
      await query("UPDATE services SET os=$1, login_pass=$2, power='on' WHERE id=$3", [OS_LIST[os], password, id]);
    } catch (e) {
      console.error("rebuild failed", e);
      return alert(ctx, "❌ خطا در ریبیلد. چند لحظه بعد دوباره تلاش کنید.");
    }
    await showService(ctx, id, "✅ ریبیلد انجام شد؛ پسورد جدید را ببینید");
  });

  // ── حذف ───────────────────────────────────────────────────
  bot.callbackQuery(/^del:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    if (!(await getOwnActive(uid(ctx), id))) return alert(ctx, "این سرور فعال نیست یا یافت نشد.");
    const kb = new InlineKeyboard().text("✅ بله، حذف شود", `delc:${id}`).row().text("❌ انصراف", `svc:${id}`);
    await show(ctx, `⚠️ از حذف سرور #${id} مطمئن هستید؟ این کار غیرقابل بازگشت است.`, kb);
  });

  bot.callbackQuery(/^delc:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const rows = await query(
      `UPDATE services SET status='deleted', deleted_at=now()
       WHERE id=$1 AND user_id=$2 AND status='active' RETURNING id`,
      [id, uid(ctx)],
    );
    if (rows.length === 0) return alert(ctx, "این سرور فعال نیست یا یافت نشد.");
    await deleteServer(id).catch((e) => console.error("deleteServer failed", e));
    await show(ctx, "🗑 سرور حذف شد.", backKb([["📦 سرویس‌های من", "services"]]));
  });
}

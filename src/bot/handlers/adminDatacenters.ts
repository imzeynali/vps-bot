import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { config } from "@/core";
import { query } from "@/core";
import { getDatacenter, isEnabled, listDatacenters, setEnabled } from "@/datacenters";
import type { DatacenterProvider } from "@/datacenters";
import { alert, esc, show } from "../helpers";

const isAdmin = (ctx: BotContext) => !!ctx.from && config.admins.includes(ctx.from.id);

async function line(p: DatacenterProvider): Promise<string> {
  const en = await isEnabled(p.id);
  const state = !p.implemented ? "🚧 در دست توسعه" : p.isConfigured() ? "✅ آماده" : "⚠️ تنظیم نشده (.env.local)";
  const cnt = await query<{ n: number }>(
    "SELECT count(*)::int AS n FROM services WHERE datacenter=$1 AND status IN ('active','suspended','provisioning')",
    [p.id],
  );
  return (
    `${p.region === "ir" ? "🇮🇷" : "🌍"} <b>${esc(p.title)}</b> <code>${p.id}</code>\n` +
    `   وضعیت: ${state}\n   منوی خرید: ${en ? "🟢 روشن" : "🔴 خاموش"}\n   سرویس‌های فعال: ${cnt[0]?.n ?? 0}`
  );
}

async function render(ctx: BotContext, toast?: string) {
  const all = listDatacenters();
  const lines = await Promise.all(all.map(line));
  const kb = new InlineKeyboard();
  for (const p of all) {
    kb.text(`🩺 تست ${p.title}`, `adm:dc:h:${p.id}`).text((await isEnabled(p.id)) ? `🔴 خاموش` : `🟢 روشن`, `adm:dc:t:${p.id}`).row();
  }
  kb.text("🔄 بروزرسانی", "adm:dc").row().text("🔙 پنل مدیریت", "admin");
  await show(
    ctx,
    `🌐 <b>دیتاسنترها</b>\n\n${lines.join("\n\n")}\n\n` +
      `ℹ️ خاموش کردن فقط از منوی خرید حذف می‌کند؛ سرویس‌های موجود (مدیریت، صورتحساب، حذف) بدون تغییر کار می‌کنند.`,
    kb,
    toast,
  );
}

export function registerAdminDatacenters(bot: Bot<BotContext>) {
  bot.callbackQuery("adm:dc", async (ctx) => {
    if (!isAdmin(ctx)) return alert(ctx, "دسترسی ندارید");
    await render(ctx);
  });

  bot.callbackQuery(/^adm:dc:t:(\w+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return alert(ctx, "دسترسی ندارید");
    const p = getDatacenter(ctx.match[1]);
    if (!p) return alert(ctx, "دیتاسنتر نامعتبر");
    await setEnabled(p.id, !(await isEnabled(p.id)));
    await render(ctx, "ذخیره شد");
  });

  bot.callbackQuery(/^adm:dc:h:(\w+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return alert(ctx, "دسترسی ندارید");
    const p = getDatacenter(ctx.match[1]);
    if (!p) return alert(ctx, "دیتاسنتر نامعتبر");
    await ctx.answerCallbackQuery({ text: "⏳ در حال تست اتصال…" }).catch(() => {});
    // خطای هر دیتاسنتر فقط همین تست را تحت تأثیر قرار می‌دهد
    const r = await p.health().catch((e) => ({ ok: false, detail: e instanceof Error ? e.message : String(e), ms: undefined }));
    await ctx.reply(
      `${r.ok ? "✅" : "❌"} <b>${esc(p.title)}</b>: ${esc(r.detail)}${r.ms ? `\n⏱ ${r.ms}ms` : ""}`,
      { parse_mode: "HTML" },
    );
  });
}

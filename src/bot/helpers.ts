import type { InlineKeyboard } from "grammy";
import type { BotContext } from "./context";

export const esc = (s: string | null | undefined) =>
  (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** رم به‌صورت خوانا (مگابایت اگر کمتر از ۱ گیگ) */
export const ramLabel = (p: { ram_gb: number; ram_mb?: number | null }) => {
  const mb = p.ram_mb ?? p.ram_gb * 1024;
  if (!mb) return "?";
  return mb < 1024 ? `${mb}MB` : `${Math.round((mb / 1024) * 10) / 10}G`;
};

/** مثلاً 2C/4G/50G (بخش‌های نامشخص حذف می‌شوند) */
export const specText = (p: { cpu: number; ram_gb: number; ram_mb?: number | null; disk_gb: number }) =>
  [p.cpu ? `${p.cpu}C` : "", ramLabel(p) === "?" ? "" : ramLabel(p), p.disk_gb ? `${p.disk_gb}G` : ""].filter(Boolean).join("/");

/** متن دکمه‌ی پلن: irvps1-1CPU-1GB RAM-10GB HARD */
export const planButton = (p: { name: string; cpu: number; ram_gb: number; ram_mb?: number | null; disk_gb: number }) => {
  const mb = p.ram_mb ?? p.ram_gb * 1024;
  const ram = !mb ? "" : mb < 1024 ? `${mb}MB` : `${Math.round((mb / 1024) * 10) / 10}GB`;
  return [p.name, p.cpu ? `${p.cpu}CPU` : "", ram ? `${ram} RAM` : "", p.disk_gb ? `${p.disk_gb}GB HARD` : ""]
    .filter(Boolean)
    .join("-");
};

export const fmt = (n: number) => n.toLocaleString("en-US");

export const uid = (ctx: BotContext) => ctx.from!.id;

/** اعداد فارسی/عربی را به انگلیسی تبدیل می‌کند */
export function normalizeDigits(s: string) {
  return s
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[,،\s]/g, "");
}

/**
 * اگر پیام از دکمه (callback) آمده باشد همان پیام را ویرایش می‌کند، وگرنه پیام جدید می‌فرستد.
 * toast: پیام کوتاهی که بالای صفحه نشان داده می‌شود.
 */
export async function show(ctx: BotContext, text: string, kb: InlineKeyboard, toast?: string) {
  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", reply_markup: kb });
    } catch (e) {
      const msg = String((e as { description?: string }).description ?? e);
      if (!msg.includes("message is not modified")) {
        await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
      }
    }
    await ctx.answerCallbackQuery(toast ? { text: toast } : undefined);
  } else {
    await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb });
  }
}

export async function alert(ctx: BotContext, text: string) {
  await ctx.answerCallbackQuery({ text: text.slice(0, 200), show_alert: true }); // سقف تلگرام ۲۰۰ کاراکتر
}

import type { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "./context";
import { config } from "@/lib/config";
import { query } from "@/lib/db";
import { esc, uid } from "./helpers";

/**
 * ایموجی پرمیوم (custom emoji) برای پرچم ایران 🇮🇷 روی دکمه‌ها.
 * شناسه در جدول settings با کلید emoji_ir ذخیره می‌شود. تلگرام (Bot API 9.4) این را فقط وقتی می‌پذیرد
 * که مالک ربات Telegram Premium داشته باشد (یا ربات username اضافه از Fragment خریده باشد).
 */
const KEY = "emoji_ir";
const FLAG = "🇮🇷";
const ID_RE = /^\d{5,25}$/;
/** پیش‌فرض: ایموجی پرمیوم ایران. با /setemoji <id> عوض و با /setemoji off خاموش می‌شود. */
const DEFAULT_IR_ID = "6296527291224695668";

let cache: { at: number; id: string | null } | null = null;

export async function irEmojiId(): Promise<string | null> {
  if (cache && Date.now() - cache.at < 30_000) return cache.id;
  const rows = await query<{ value: string }>("SELECT value FROM settings WHERE key=$1", [KEY]);
  const v = rows[0]?.value;
  // ردیفی نباشد ← پیش‌فرض؛ "off" ← خاموش؛ عدد ← همان شناسه
  const id = v === undefined ? DEFAULT_IR_ID : ID_RE.test(v) ? v : null;
  cache = { at: Date.now(), id };
  return id;
}

export async function setIrEmojiId(id: string | null) {
  if (id) {
    await query("INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [KEY, id]);
  } else {
    await query("INSERT INTO settings (key, value) VALUES ($1,'off') ON CONFLICT (key) DO UPDATE SET value='off'", [KEY]);
  }
  cache = null;
}

/** دکمه‌ی لوکیشن: اگر عنوان با 🇮🇷 شروع شود و شناسه تنظیم باشد، پرچم به‌صورت ایموجی پرمیوم کنار متن می‌آید */
export function locButton(kb: InlineKeyboard, title: string, data: string, emojiId: string | null): InlineKeyboard {
  if (emojiId && title.startsWith(FLAG)) {
    const text = title.slice(FLAG.length).trim() || "ایران";
    // نوع‌های grammY ممکن است هنوز icon_custom_emoji_id را نشناسند
    return kb.add({ text, callback_data: data, icon_custom_emoji_id: emojiId } as unknown as Parameters<InlineKeyboard["add"]>[0]);
  }
  return kb.text(title, data);
}

/**
 * منو را با ایموجی پرمیوم می‌فرستد؛ اگر تلگرام قبول نکرد (مثلاً مالک ربات Premium ندارد) به‌جای خراب شدن منو،
 * ایموجی پرمیوم خودکار غیرفعال می‌شود و منو با ایموجی معمولی ارسال می‌شود.
 */
export async function withPremiumFallback(bot: Bot<BotContext>["api"] | null, run: (emojiId: string | null) => Promise<void>) {
  const id = await irEmojiId();
  try {
    await run(id);
  } catch (e) {
    if (!id) throw e;
    console.error("premium emoji rejected, disabling:", e instanceof Error ? e.message : e);
    await setIrEmojiId(null);
    if (bot) for (const a of config.admins) void bot.sendMessage(a, "⚠️ تلگرام ایموجی پرمیوم را نپذیرفت و غیرفعال شد (مالک ربات باید Telegram Premium داشته باشد). منو با ایموجی معمولی نمایش داده می‌شود.").catch(() => {});
    await run(null);
  }
}

const isAdmin = (ctx: BotContext) => config.admins.includes(uid(ctx));

export function registerPremiumEmoji(bot: Bot<BotContext>) {
  // ادمین یک پیام شامل ایموجی پرمیوم بفرستد ← ربات شناسه‌ی آن را برمی‌گرداند
  bot.on("message:entities:custom_emoji", async (ctx, next) => {
    if (!isAdmin(ctx)) return next();
    const ids = [...new Set((ctx.message.entities ?? []).filter((e) => e.type === "custom_emoji").map((e) => (e as { custom_emoji_id: string }).custom_emoji_id))];
    if (ids.length === 0) return next();
    const lines = ids.map((i) => `<code>${esc(i)}</code>`).join("\n");
    await ctx.reply(
      `🆔 <b>شناسه‌ی ایموجی پرمیوم</b>\n${lines}\n\n` + (ids.length === 1 ? `برای گذاشتن روی پرچم ایران:\n<code>/setemoji ${esc(ids[0]!)}</code>` : "فقط یک ایموجی بفرستید تا دستور آماده‌ی ثبت را بدهم."),
      { parse_mode: "HTML" },
    );
  });

  bot.command("setemoji", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const arg = String(ctx.match ?? "").trim();
    if (arg === "off") {
      await setIrEmojiId(null);
      return void ctx.reply("✅ ایموجی پرمیوم غیرفعال شد (پرچم معمولی 🇮🇷).");
    }
    if (!ID_RE.test(arg)) {
      return void ctx.reply("فرمت: /setemoji <شناسه>\nشناسه را با فرستادن خود ایموجی پرمیوم به ربات بگیرید.\nغیرفعال کردن: /setemoji off");
    }
    await setIrEmojiId(arg);
    await ctx.reply("✅ ثبت شد. منوی «خرید سرویس» را باز کنید و دکمه‌ی ایران را ببینید. اگر تلگرام نپذیرد، خودکار غیرفعال می‌شود.");
  });

  bot.command("emoji", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const id = await irEmojiId();
    await ctx.reply(id ? `ایموجی پرمیوم ایران: <code>${esc(id)}</code>\nغیرفعال: /setemoji off` : "ایموجی پرمیوم تنظیم نشده. یک ایموجی پرمیوم برای ربات بفرستید تا شناسه‌اش را بدهد.", { parse_mode: "HTML" });
  });
}

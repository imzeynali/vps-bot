import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { config } from "@/lib/config";
import { query } from "@/lib/db";
import { discover, isConfigured } from "@/lib/virtualizor";
import { alert, esc, uid } from "../helpers";

const isAdmin = (ctx: BotContext) => config.admins.includes(uid(ctx));
const KEY = /^\w{1,16}$/;

const FORMAT_LOC = "فرمت: /addloc کلید|عنوان|serid\nمثال: /addloc iran|🇮🇷 ایران|0";
const FORMAT_OS = "فرمت: /addos کلید|نام|osid\nمثال: /addos u22|Ubuntu 22.04|123";

async function catalogText() {
  const locs = await query<{ key: string; title: string; serid: number }>(
    "SELECT key, title, serid FROM locations WHERE active ORDER BY key",
  );
  const oses = await query<{ key: string; name: string; osid: number }>(
    "SELECT key, name, osid FROM os_templates WHERE active ORDER BY name",
  );
  return (
    `📍 <b>لوکیشن‌های فعال</b>\n` +
    (locs.map((l) => `• <code>${esc(l.key)}</code> — ${esc(l.title)} (serid ${l.serid})`).join("\n") || "— هیچ —") +
    `\n\n💿 <b>سیستم‌عامل‌های فعال</b>\n` +
    (oses.map((o) => `• <code>${esc(o.key)}</code> — ${esc(o.name)} (osid ${o.osid})`).join("\n") || "— هیچ —")
  );
}

/** گزارش اتصال + شناسه‌های پنل. filter: فیلتر نام سیستم‌عامل‌ها */
async function virtReport(filter = "") {
  if (!isConfigured()) {
    return "❌ اتصال Virtualizor تنظیم نشده.\nمقادیر VIRT_URL ، VIRT_API_KEY و VIRT_API_PASS را در .env.local بگذارید (در سرور: <code>vpsbot</code> ← Bot settings).";
  }
  const d = await discover();
  if (!d.ok) return `❌ اتصال به پنل برقرار نشد:\n<code>${esc(d.error)}</code>`;

  const f = filter.trim().toLowerCase();
  const os = d.os.filter((o) => !f || o.name.toLowerCase().includes(f));
  const lines = [
    `✅ <b>اتصال به Virtualizor برقرار است</b>\n<code>${esc(config.virt.url)}</code>`,
    `\n🖥 <b>Server/Node ها</b> (serid)\n` +
      (d.servers.map((s) => `• ${s.id} — ${esc(s.name)} ${s.virt ? `[${esc(s.virt)}]` : ""}`).join("\n") || "— (پیدا نشد؛ معمولاً 0)"),
    `\n💿 <b>OS Template ها</b> (osid)${f ? ` — فیلتر «${esc(f)}»` : ""}\n` +
      (os.slice(0, 40).map((o) => `• ${o.id} — ${esc(o.name)} ${o.virt ? `[${esc(o.virt)}]` : ""}`).join("\n") || "— (پیدا نشد)") +
      (os.length > 40 ? `\n… و ${os.length - 40} مورد دیگر؛ فیلتر کنید: /virt ubuntu` : ""),
  ];
  if (d.plans.length) lines.push(`\n📋 <b>Plan ها</b> (plid)\n` + d.plans.slice(0, 15).map((p) => `• ${p.id} — ${esc(p.name)}`).join("\n"));
  if (d.pools.length) lines.push(`\n🌐 <b>IP Pool ها</b>\n` + d.pools.slice(0, 15).map((p) => `• ${p.id} — ${esc(p.name)}`).join("\n"));
  lines.push(
    `\n➕ <b>تعریف در ربات</b>\n<code>/addloc iran|🇮🇷 ایران|0</code>\n<code>/addos u22|Ubuntu 22.04|OSID</code>\n/catalog — موارد تعریف‌شده`,
  );
  let text = lines.join("\n");
  if (text.length > 3900) text = text.slice(0, 3900) + "\n…";
  return text;
}

export function registerAdminVirt(bot: Bot<BotContext>) {
  bot.command("virt", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.reply("⏳ در حال اتصال به پنل…");
    await ctx.reply(await virtReport(ctx.match), { parse_mode: "HTML" });
  });

  bot.callbackQuery("adm:virt", async (ctx) => {
    if (!isAdmin(ctx)) return alert(ctx, "دسترسی ندارید");
    await ctx.answerCallbackQuery({ text: "⏳ در حال اتصال به پنل…" });
    const text = (await virtReport()) + "\n\n" + (await catalogText());
    await ctx.editMessageText(text.slice(0, 4000), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("🔄 بروزرسانی", "adm:virt").row().text("🔙 پنل مدیریت", "admin"),
    }).catch(() => {});
  });

  bot.command("catalog", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.reply(await catalogText(), { parse_mode: "HTML" });
  });

  bot.command("addloc", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [key, title, serid] = ctx.match.split("|").map((x) => x.trim());
    if (!key || !KEY.test(key) || !title || !/^\d+$/.test(serid ?? "")) return void ctx.reply(FORMAT_LOC);
    await query(
      `INSERT INTO locations (key,title,serid) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET title=EXCLUDED.title, serid=EXCLUDED.serid, active=TRUE`,
      [key, title, Number(serid)],
    );
    await ctx.reply("✅ لوکیشن ثبت شد.");
  });

  bot.command("addos", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [key, name, osid] = ctx.match.split("|").map((x) => x.trim());
    if (!key || !KEY.test(key) || !name || !/^\d+$/.test(osid ?? "")) return void ctx.reply(FORMAT_OS);
    await query(
      `INSERT INTO os_templates (key,name,osid) VALUES ($1,$2,$3)
       ON CONFLICT (key) DO UPDATE SET name=EXCLUDED.name, osid=EXCLUDED.osid, active=TRUE`,
      [key, name, Number(osid)],
    );
    await ctx.reply("✅ سیستم‌عامل ثبت شد.");
  });

  bot.command("delloc", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const r = await query("UPDATE locations SET active=FALSE WHERE key=$1 RETURNING key", [ctx.match.trim()]);
    await ctx.reply(r.length ? "✅ غیرفعال شد." : "پیدا نشد. فرمت: /delloc کلید");
  });

  bot.command("delos", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const r = await query("UPDATE os_templates SET active=FALSE WHERE key=$1 RETURNING key", [ctx.match.trim()]);
    await ctx.reply(r.length ? "✅ غیرفعال شد." : "پیدا نشد. فرمت: /delos کلید");
  });
}

import { InlineKeyboard } from "grammy";
import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { config } from "@/lib/config";
import { query } from "@/lib/db";
import { discover, isConfigured } from "@/lib/virtualizor";
import { importPanelPlans } from "@/lib/provider";
import { approveTrial, cancelTrial } from "@/lib/trial";
import { alert, esc, fmt, specText, uid } from "../helpers";

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
  // فقط OSهای نوع مجازی‌سازی انتخاب‌شده (پیش‌فرض kvm)؛ با «/virt all» همه نمایش داده می‌شود
  const all = f === "all";
  const os = d.os.filter(
    (o) => (all || !o.virt || o.virt === config.virt.type) && (!f || all || o.name.toLowerCase().includes(f)),
  );
  const lines = [
    `✅ <b>اتصال به Virtualizor برقرار است</b>\n<code>${esc(config.virt.url)}</code>`,
    `\n🖥 <b>Server/Node ها</b> (serid)\n` +
      (d.servers.map((s) => `• ${s.id} — ${esc(s.name)} ${s.virt ? `[${esc(s.virt)}]` : ""}`).join("\n") || "— (پیدا نشد؛ معمولاً 0)"),
    `\n💿 <b>OS Template ها</b> (osid) — نوع <b>${esc(all ? "همه" : config.virt.type)}</b>${f && !all ? ` — فیلتر «${esc(f)}»` : ""}\n` +
      (os.slice(0, 40).map((o) => `• ${o.id} — ${esc(o.name)} ${o.virt ? `[${esc(o.virt)}]` : ""}`).join("\n") || "— (پیدا نشد)") +
      (os.length > 40 ? `\n… و ${os.length - 40} مورد دیگر؛ فیلتر کنید: /virt ubuntu` : ""),
  ];
  if (d.plans.length) lines.push(`\n📋 <b>Plan ها</b> (plid)\n` + d.plans.slice(0, 15).map((p) => `• ${p.id} — ${esc(p.name)} (${p.cores ?? "?"}C / ${p.ramMb ?? "?"}MB / ${p.spaceGb ?? "?"}G)`).join("\n"));
  if (d.pools.length) lines.push(`\n🌐 <b>IP Pool ها</b>\n` + d.pools.slice(0, 15).map((p) => `• ${p.id} — ${esc(p.name)}`).join("\n"));
  lines.push(
    `\n➕ <b>تعریف در ربات</b>\n<code>/addloc iran|🇮🇷 ایران|0</code>\n<code>/addos u22|Ubuntu 22.04|OSID</code>\n/catalog — موارد تعریف‌شده\n/importplans — وارد کردن پلن‌های پنل در ربات`,
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


  // لیست پلن‌های ربات
  bot.command("plans", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const rows = await query<{ id: number; name: string; cpu: number; ram_gb: number; ram_mb: number | null; disk_gb: number; hourly_price: number; monthly_price: number | null; active: boolean; virt_plid: number | null }>(
      "SELECT * FROM plans ORDER BY id",
    );
    if (!rows.length) return void ctx.reply("پلنی وجود ندارد. /importplans را بزنید.");
    const lines = rows.map(
      (p) =>
        `${p.active && p.hourly_price > 0 ? "🟢" : "⚪️"} <b>#${p.id}</b> ${esc(p.name)} — ${esc(specText(p) || "منابع از پنل")} — ${fmt(p.hourly_price)} ت/ساعت` +
        (p.monthly_price ? ` — ماهانه ${fmt(p.monthly_price)}` : "") +
        (p.virt_plid ? ` — plid ${p.virt_plid}` : ""),
    );
    await ctx.reply(lines.join("\n") + "\n\n🟢 = قابل فروش\n/setprice شناسه قیمت\n/delplan شناسه", { parse_mode: "HTML" });
  });

  // وارد کردن پلن‌های Virtualizor
  bot.command("importplans", async (ctx) => {
    if (!isAdmin(ctx)) return;
    await ctx.reply("⏳ در حال خواندن پلن‌ها از پنل…");
    try {
      const r = await importPanelPlans();
      if (!r.length) return void ctx.reply("پلنی (از نوع " + config.virt.type + ") در پنل پیدا نشد.");
      await ctx.reply(
        `✅ ${r.filter((x) => x.created).length} پلن جدید وارد شد (${r.length} پلن در پنل)\n\n` +
          r.map((x) => `• #${x.id} ${esc(x.name)} (plid ${x.plid})${x.created ? " — جدید" : ""}`).join("\n") +
          `\n\nحالا برای هر پلن قیمت ساعتی (تومان) بدهید تا برای فروش فعال شود:\n<code>/setprice 1 300</code>\n/plans — مشاهده پلن‌ها`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      await ctx.reply("❌ " + (e instanceof Error ? e.message : "خطا"));
    }
  });

  // /setplan شناسه|نام|cpu|ram(GB)|disk(GB)|قیمت_ساعتی|قیمت_ماهانه[|plid]
  bot.command("setplan", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const f = ctx.match.split("|").map((x) => x.trim());
    const [id, name, cpu, ram, disk, hourly, monthly, plid] = f;
    if (
      (f.length !== 7 && f.length !== 8) ||
      !name ||
      [id, cpu, ram, disk, hourly, monthly].some((x) => !/^\d+$/.test(x ?? "")) ||
      (plid !== undefined && !/^\d+$/.test(plid))
    ) {
      return void ctx.reply(
        "فرمت: /setplan شناسه|نام|cpu|ram(GB)|disk(GB)|قیمت_ساعتی|قیمت_ماهانه[|plid]\nمثال: /setplan 1|irvps1|1|1|10|1750|770000|1",
      );
    }
    const r = await query(
      `UPDATE plans SET name=$2, cpu=$3, ram_gb=$4, ram_mb=$4*1024, disk_gb=$5, hourly_price=$6,
              monthly_price=$7, active=($6 > 0), virt_plid=COALESCE($8, virt_plid)
        WHERE id=$1 RETURNING id`,
      [Number(id), name, Number(cpu), Number(ram), Number(disk), Number(hourly), Number(monthly), plid ? Number(plid) : null],
    );
    await ctx.reply(r.length ? "✅ پلن به‌روز شد (/plans)." : "پلن پیدا نشد.");
  });

  bot.command("setprice", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const [id, price] = ctx.match.trim().split(/\s+/);
    if (!/^\d+$/.test(id ?? "") || !/^\d+$/.test(price ?? "")) return void ctx.reply("فرمت: /setprice شناسه_پلن قیمت_ساعتی\nمثال: /setprice 1 300");
    const r = await query("UPDATE plans SET hourly_price=$2, active = ($2 > 0) WHERE id=$1 RETURNING id", [Number(id), Number(price)]);
    await ctx.reply(r.length ? (Number(price) > 0 ? "✅ قیمت ثبت و پلن فعال شد." : "✅ قیمت صفر شد و پلن غیرفعال شد.") : "پلن پیدا نشد.");
  });

  bot.command("delplan", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const id = ctx.match.trim();
    if (!/^\d+$/.test(id)) return void ctx.reply("فرمت: /delplan شناسه_پلن");
    const r = await query("UPDATE plans SET active=FALSE WHERE id=$1 RETURNING id", [Number(id)]);
    await ctx.reply(r.length ? "✅ پلن غیرفعال شد (برای سرویس‌های فعلی تأثیری ندارد)." : "پلن پیدا نشد.");
  });

  // ── دوره‌ی تست سرویس ماهانه: تصمیم ادمین بعد از «گزارش مشکل» ──
  bot.callbackQuery(/^adm:tok:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return alert(ctx, "دسترسی ندارید");
    const ok = await approveTrial(ctx.api, Number(ctx.match[1]));
    await ctx.answerCallbackQuery({ text: ok ? "✅ ثبت شد؛ مابقی مبلغ به‌زودی کسر می‌شود" : "سرویس تست‌شده پیدا نشد", show_alert: true });
  });
  bot.callbackQuery(/^adm:tx:(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) return alert(ctx, "دسترسی ندارید");
    const r = await cancelTrial(ctx.api, Number(ctx.match[1]));
    await ctx.answerCallbackQuery({ text: r.msg.slice(0, 200), show_alert: true });
  });
  bot.command("trialok", async (ctx) => {
    if (!isAdmin(ctx)) return;
    if (!/^\d+$/.test(ctx.match.trim())) return void ctx.reply("فرمت: /trialok شناسه_سرویس");
    await ctx.reply((await approveTrial(ctx.api, Number(ctx.match.trim()))) ? "✅ ثبت شد." : "سرویس تست‌شده پیدا نشد.");
  });
  bot.command("trialcancel", async (ctx) => {
    if (!isAdmin(ctx)) return;
    if (!/^\d+$/.test(ctx.match.trim())) return void ctx.reply("فرمت: /trialcancel شناسه_سرویس");
    await ctx.reply((await cancelTrial(ctx.api, Number(ctx.match.trim()))).msg);
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

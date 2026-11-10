import type { Bot } from "grammy";
import type { BotContext } from "../context";
import { config, query, queryOne } from "@/core";
import { esc, fmt } from "../helpers";

/**
 * قیمت «پهنای باند» پلن‌های CGI (قیمت تمام‌شده‌ی سرور برای هر سرعت). فقط ادمین.
 *   /bw                                   ← لیست قیمت‌ها
 *   /setbw hostvds-1 2782/3154/3898       ← قیمت ساعتیِ ۱۰۰/۱۰۰۰/۱۰۰۰۰ مگابیت یک‌جا (ماهانه = ساعتی × ۷۲۰)
 *   /setbw hostvds-1 1000 3154 [2270880]  ← یک سرعت (ماهانه اختیاری؛ پیش‌فرض ساعتی × ۷۲۰)
 *   /setbw hostvds-1 1000 off             ← غیرفعال کردن یک سرعت
 *   /setbw hostvds-1 1000 qos <policyId>  ← (اختیاری) QoS policy برای اعمال محدودیت سرعت روی پورت
 */
const TIERS = [100, 1000, 10000];
const isAdmin = (ctx: BotContext) => !!ctx.from && config.admins.includes(ctx.from.id);
const num = (s: string | undefined) => (s && /^\d{1,12}$/.test(s) ? Number(s) : null);

const HELP =
  "📶 <b>قیمت پهنای باند (CGI)</b>\n\n" +
  "<code>/bw</code> — لیست قیمت‌ها\n" +
  "<code>/setbw hostvds-1 2782/3154/3898</code> — ساعتیِ ۱۰۰/۱۰۰۰/۱۰۰۰۰ مگابیت (ماهانه = ساعتی × ۷۲۰)\n" +
  "<code>/setbw hostvds-1 1000 3154 2270880</code> — یک سرعت (ماهانه اختیاری)\n" +
  "<code>/setbw hostvds-1 1000 off</code> — غیرفعال کردن یک سرعت\n" +
  "<code>/setbw hostvds-1 1000 qos POLICY_ID</code> — اعمال QoS (اختیاری)";

export function registerAdminBandwidth(bot: Bot<BotContext>) {
  bot.command("bw", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const rows = await query<{ name: string; mbps: number; hourly_price: number; monthly_price: number | null; active: boolean; qos_ref: string | null }>(
      `SELECT p.name, b.mbps, b.hourly_price, b.monthly_price, b.active, b.qos_ref
         FROM bandwidth_prices b JOIN plans p ON p.id = b.plan_id WHERE p.datacenter='cgi' ORDER BY p.hourly_price, p.name, b.mbps`,
    );
    if (rows.length === 0) return void ctx.reply(HELP + "\n\n⚠️ هنوز هیچ قیمتی ثبت نشده؛ پلن‌های CGI تا قیمت‌گذاری در منوی خرید نمایش داده نمی‌شوند.", { parse_mode: "HTML" });
    let out = "📶 <b>قیمت پهنای باند (تمام‌شده)</b>\n";
    let cur = "";
    for (const r of rows) {
      if (r.name !== cur) out += `\n<b>${esc(r.name)}</b>\n`, (cur = r.name);
      out += `${r.active ? "✅" : "⛔️"} ${r.mbps}MB: ساعتی ${fmt(r.hourly_price)} | ماهانه ${r.monthly_price ? fmt(r.monthly_price) : "—"}${r.qos_ref ? ` | QoS ${esc(r.qos_ref)}` : ""}\n`;
    }
    await ctx.reply(out, { parse_mode: "HTML" });
  });

  bot.command("setbw", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const args = ctx.match.trim().split(/\s+/).filter(Boolean);
    if (args.length < 2) return void ctx.reply(HELP, { parse_mode: "HTML" });
    const plan = await queryOne<{ id: number; name: string }>("SELECT id, name FROM plans WHERE datacenter='cgi' AND lower(name)=lower($1)", [args[0]]);
    if (!plan) return void ctx.reply(`❌ پلن CGI با نام «${esc(args[0])}» پیدا نشد.`, { parse_mode: "HTML" });

    const upsert = (mbps: number, hourly: number, monthly: number | null) =>
      query(
        `INSERT INTO bandwidth_prices (plan_id, mbps, hourly_price, monthly_price, active) VALUES ($1,$2,$3,$4,TRUE)
         ON CONFLICT (plan_id, mbps) DO UPDATE SET hourly_price=EXCLUDED.hourly_price, monthly_price=EXCLUDED.monthly_price, active=TRUE`,
        [plan.id, mbps, hourly, monthly],
      );

    // حالت یک‌جا: 2782/3154/3898
    if (args.length === 2 && args[1].includes("/")) {
      const parts = args[1].split("/").map(num);
      if (parts.length !== TIERS.length || parts.some((x) => !x)) return void ctx.reply("❌ سه قیمت ساعتی با «/» بدهید؛ مثال: 2782/3154/3898");
      for (let i = 0; i < TIERS.length; i++) await upsert(TIERS[i], parts[i]!, parts[i]! * 720);
      return void ctx.reply(`✅ قیمت پهنای باند ${esc(plan.name)} ثبت شد (ماهانه = ساعتی × ۷۲۰). برای دیدن: /bw`, { parse_mode: "HTML" });
    }

    const mbps = num(args[1]);
    if (!mbps || !TIERS.includes(mbps)) return void ctx.reply(`❌ سرعت باید یکی از ${TIERS.join(" / ")} باشد.`);
    if (args[2] === "off") {
      const r = await query("UPDATE bandwidth_prices SET active=FALSE WHERE plan_id=$1 AND mbps=$2 RETURNING mbps", [plan.id, mbps]);
      return void ctx.reply(r.length ? `⛔️ ${mbps}MB برای ${esc(plan.name)} غیرفعال شد.` : "❌ قیمتی برای این سرعت ثبت نشده بود.", { parse_mode: "HTML" });
    }
    if (args[2] === "qos") {
      if (!args[3] || !/^[\w-]{8,64}$/.test(args[3])) return void ctx.reply("❌ شناسه‌ی QoS policy نامعتبر است.");
      const r = await query("UPDATE bandwidth_prices SET qos_ref=$3 WHERE plan_id=$1 AND mbps=$2 RETURNING mbps", [plan.id, mbps, args[3]]);
      return void ctx.reply(r.length ? `✅ QoS برای ${mbps}MB ثبت شد.` : "❌ اول قیمت این سرعت را ثبت کنید.");
    }
    const hourly = num(args[2]);
    const monthly = args[3] ? num(args[3]) : hourly ? hourly * 720 : null;
    if (!hourly || !monthly) return void ctx.reply("❌ قیمت ساعتی (و ماهانه) باید عدد باشد.");
    await upsert(mbps, hourly, monthly);
    await ctx.reply(`✅ ${esc(plan.name)} — ${mbps}MB: ساعتی ${fmt(hourly)} | ماهانه ${fmt(monthly)}`, { parse_mode: "HTML" });
  });
}

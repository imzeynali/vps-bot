export {};
/**
 * ثبت قیمت پهنای باند از خط فرمان (هم‌ارز دستور ادمین /setbw در ربات؛ برای اینستالر).
 *   npm run cgi:bw -- hostvds-1 2782/3154/3898      ← ساعتی ۱۰۰/۱۰۰۰/۱۰۰۰۰ مگابیت (ماهانه = ساعتی × ۷۲۰)
 */
const TIERS = [100, 1000, 10000];
async function main() {
  const [planName, prices] = process.argv.slice(2);
  const parts = (prices ?? "").split("/").map((x) => (/^\d{1,12}$/.test(x) ? Number(x) : 0));
  if (!planName || parts.length !== TIERS.length || parts.some((x) => !x)) throw new Error("استفاده: cgi:bw -- <plan> <p100>/<p1000>/<p10000>   مثال: hostvds-1 2782/3154/3898");
  const { query, queryOne, pool } = await import("../src/core");
  try {
    const plan = await queryOne<{ id: number }>("SELECT id FROM plans WHERE datacenter='cgi' AND lower(name)=lower($1)", [planName]);
    if (!plan) throw new Error(`پلن CGI «${planName}» پیدا نشد؛ اول npm run cgi:seed`);
    for (let i = 0; i < TIERS.length; i++) {
      await query(
        `INSERT INTO bandwidth_prices (plan_id, mbps, hourly_price, monthly_price, active) VALUES ($1,$2,$3,$4,TRUE)
         ON CONFLICT (plan_id, mbps) DO UPDATE SET hourly_price=EXCLUDED.hourly_price, monthly_price=EXCLUDED.monthly_price, active=TRUE`,
        [plan.id, TIERS[i], parts[i], parts[i]! * 720],
      );
    }
    console.log(`✅ قیمت پهنای باند ${planName} ثبت شد: ${parts.join(" / ")} (ماهانه = ساعتی × ۷۲۰)`);
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});

export {};
/**
 * ورود کاتالوگ CGI از API به ربات. اجرا: npm run cgi:seed
 * نگاشت لوکیشن‌ها به ریجن: CGI_REGION_MAP در .env.local، مثلاً
 *   CGI_REGION_MAP=paris=eu-west3,nl=eu-west1,lv=eu-north1b,fi=eu-north3
 * (برای دیدن ریجن‌ها و کشورشان: npm run cgi:regions)
 */
async function main() {
  const { seedCatalog } = await import("../src/datacenters/cgi/seed");
  const { pool } = await import("../src/core");
  const r = await seedCatalog();
  console.log(`✅ پلن‌ها: ${r.plans.created} جدید | ${r.plans.activated} فعال/قیمت‌دار شد | ${r.plans.renamed} به نام تبدیل شد`);
  console.log(`✅ سیستم‌عامل‌ها: ${r.os.upserted} مورد | ${r.os.disabled} غیرفعال شد`);
  console.log(`✅ لوکیشن‌های فعال: ${r.locations.active.join("، ") || "—"}`);
  if (r.locations.inactive.length) console.log(`⚠️ بدون ریجن (غیرفعال): ${r.locations.inactive.join("، ")} ← CGI_REGION_MAP را کامل کنید`);
  await pool.end();
}
main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});

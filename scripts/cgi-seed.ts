export {};
/** ورود کاتالوگ CGI از API به ربات (پلن‌ها غیرفعال با قیمت ۰؛ قیمت را از پنل مدیریت بدهید). اجرا: npm run cgi:seed */
async function main() {
  const { seedCatalog } = await import("../src/datacenters/cgi/seed");
  const { pool } = await import("../src/core");
  const r = await seedCatalog();
  console.log(`✅ پلن‌ها: ${r.plans.created} جدید، ${r.plans.existing} از قبل موجود`);
  console.log(`✅ سیستم‌عامل‌ها: ${r.os.upserted} مورد`);
  console.log(`✅ لوکیشن: ${r.location}`);
  console.log("\nمرحله‌ی بعد: در ربات «پنل مدیریت ← پلن‌ها» برای هر پلن CGI قیمت بدهید و فعالش کنید.");
  await pool.end();
}
main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});

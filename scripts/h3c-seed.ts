export {};
/**
 * ورود کاتالوگ 3HCloud از API به ربات. اجرا: npm run h3c:seed
 * H3C_REGION_MAP (اختیاری؛ پیش‌فرض همه‌ی ریجن‌ها)  مثل mia=Miami,waw=Warsaw/WAW-1   (کدها: mia dfw sfo waw ala mnl)
 * H3C_PRICES=نام‌فلور=قیمت‌ساعتی,...   (اختیاری؛ وگرنه قیمت را از پنل ادمین بگذارید)
 */
async function main() {
  const { seedCatalog } = await import("../src/datacenters/h3c/seed");
  const { pool } = await import("../src/core");
  const r = await seedCatalog();
  console.log(`✅ پلن‌ها: ${r.plans.created} جدید | ${r.plans.activated} فعال/قیمت‌دار شد (بقیه تا قیمت‌گذاری غیرفعال‌اند)`);
  console.log(`✅ سیستم‌عامل‌ها: ${r.os.upserted} مورد | ${r.os.disabled} غیرفعال شد`);
  console.log(`✅ لوکیشن‌های فعال: ${r.locations.active.join("، ") || "—"}`);
  if (r.locations.inactive.length) console.log(`⚠️ بدون ریجن (غیرفعال): ${r.locations.inactive.join("، ")} ← H3C_REGION_MAP را کامل کنید`);
  await pool.end();
}
main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});

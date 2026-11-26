export {};
/** ورود کاتالوگ UpCloud از API به ربات. اجرا: npm run upcloud:seed   (UPCLOUD_PRICES=نام=قیمت‌ساعتی‌تومان,... اختیاری) */
async function main() {
  const { seedCatalog } = await import("../src/datacenters/upcloud/seed");
  const { pool } = await import("../src/core");
  const r = await seedCatalog();
  console.log(`✅ پلن‌ها: ${r.plans.created} جدید | ${r.plans.activated} فعال/قیمت‌دار شد (بقیه تا قیمت‌گذاری غیرفعال‌اند)`);
  console.log(`✅ سیستم‌عامل‌ها: ${r.os.upserted} مورد | ${r.os.disabled} غیرفعال شد`);
  console.log(`✅ لوکیشن‌ها: ${r.locations.active.join("، ") || "—"}`);
  if (r.locations.missing.length) console.log(`⚠️ در حساب پیدا نشد: ${r.locations.missing.join("، ")}`);
  await pool.end();
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });

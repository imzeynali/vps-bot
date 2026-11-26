export {};
/** ورود کاتالوگ Virtua از API به ربات. اجرا: npm run virtua:seed   (VIRTUA_PRICES=نام=قیمت‌ساعتی‌تومان,... اختیاری) */
async function main() {
  const { seedCatalog } = await import("../src/datacenters/virtua/seed");
  const { pool } = await import("../src/core");
  const r = await seedCatalog();
  console.log(`✅ پلن‌ها: ${r.plans.created} جدید | ${r.plans.activated} فعال/قیمت‌دار شد (بقیه تا قیمت‌گذاری غیرفعال‌اند)`);
  for (const o of r.plans.list.slice(0, 25)) console.log(`   ${o.name}: €${o.priceHourEur ?? "?"}/ساعت`);
  console.log(`✅ سیستم‌عامل‌ها: ${r.os.upserted} مورد | ${r.os.disabled} غیرفعال شد`);
  console.log(`✅ لوکیشن: ${r.location}`);
  await pool.end();
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });

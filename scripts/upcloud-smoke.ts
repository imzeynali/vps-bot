export {};
/**
 * تست زنده‌ی UpCloud روی API واقعی (یک سرور واقعی می‌سازد و هزینه‌ی ساعتی کوچکی دارد).
 *   npx tsx --env-file=.env.local scripts/upcloud-smoke.ts create [osKey] [zone] ← ساخت (پیش‌فرض up_ubuntu_2404، کوچک‌ترین پلن، اولین زون UPCLOUD_ZONES)
 *   npx tsx --env-file=.env.local scripts/upcloud-smoke.ts delete <serviceId> ← توقف و حذف سرور با دیسک
 * بعد از create با نمایش‌داده‌شده ssh بزنید تا ورود root با پسورد (cloud-init) تأیید شود.
 */
async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const { query, queryOne, pool, genPassword } = await import("../src/core");
  const P = await import("../src/lib/provider");
  try {
    if (cmd === "create") {
      const [, , regionArg] = process.argv.slice(2);
      const osKey = arg || "up_ubuntu_2404";
      const meta = { region: regionArg || (process.env.UPCLOUD_ZONES || "fi-hel1").split(",")[0]!.trim() };
      const plan = await queryOne<{ id: number; name: string }>("SELECT id, name FROM plans WHERE datacenter='upcloud' AND dc_ref IS NOT NULL ORDER BY ram_mb, cpu LIMIT 1");
      if (!plan) throw new Error("پلن UpCloud نیست؛ اول npm run upcloud:seed");
      if (!(await queryOne("SELECT 1 FROM os_templates WHERE key=$1 AND datacenter='upcloud'", [osKey]))) throw new Error(`OS ${osKey} نیست؛ اول npm run upcloud:seed`);
      await query("INSERT INTO users (id, balance) VALUES (-1, 0) ON CONFLICT (id) DO NOTHING");
      const sid = (await queryOne<{ id: number }>(
        `INSERT INTO services (user_id, plan_id, hourly_price, status, datacenter, location_key, os_key, login_user, login_pass, panel_pass, dc_meta)
         VALUES (-1, $1, 0, 'provisioning', 'upcloud', 'upcloud_smoke', $2, 'root', $3, 'smoke', $4::jsonb) RETURNING id`,
        [plan.id, osKey, genPassword(), JSON.stringify(meta)],
      ))!.id;
      console.log(`⏳ ساخت سرور آزمایشی #${sid} (پلن ${plan.name}، زون ${meta.region}) … تا چند دقیقه`);
      const r = await P.provisionServer(sid);
      await query("UPDATE services SET status='active', external_id=$2, ip=$3, dc_meta=$4::jsonb WHERE id=$1", [sid, r.externalId, r.ip, JSON.stringify(r.meta ?? {})]);
      const pass = (await queryOne<{ login_pass: string }>("SELECT login_pass FROM services WHERE id=$1", [sid]))!.login_pass;
      console.log(`\n✅ ساخته شد\n   IP: ${r.ip}\n   ssh root@${r.ip}\n   پسورد: ${pass}\n\n(ورود SSH ممکن است ۱ تا ۲ دقیقه بعد از ACTIVE آماده شود.)\nپایان تست: scripts/upcloud-smoke.ts delete ${sid}`);
    } else if (cmd === "delete" && arg) {
      const sid = Number(arg);
      await P.deleteServer(sid);
      await query("UPDATE services SET status='deleted', deleted_at=now() WHERE id=$1 AND datacenter='upcloud'", [sid]);
      console.log(`🗑 سرور #${sid} حذف شد.`);
    } else {
      console.log("استفاده: create [osKey] | delete <serviceId>");
    }
  } finally {
    await pool.end();
  }
}
main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});

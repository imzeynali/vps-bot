export {};
/**
 * تست زنده‌ی CGI روی API واقعی (یک سرور واقعی می‌سازد و هزینه‌ی ساعتی کوچکی دارد).
 *   npx tsx --env-file=.env.local scripts/cgi-smoke.ts create [osKey] [region] [network] ← ساخت (پیش‌فرض cg_ubuntu_2404، کوچک‌ترین پلن، ریجن CGI_REGION، شبکه‌ی تصادفی)
 *   npx tsx --env-file=.env.local scripts/cgi-smoke.ts delete <serviceId> ← حذف سرور و پورت
 * بعد از create با نمایش‌داده‌شده ssh بزنید تا ورود root با پسورد (cloud-init) تأیید شود.
 */
async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const { query, queryOne, pool, genPassword } = await import("../src/core");
  const P = await import("../src/lib/provider");
  try {
    if (cmd === "create") {
      const [, , regionArg, netArg] = process.argv.slice(2);
      const osKey = arg || "cg_ubuntu_2404";
      const meta = { region: regionArg || process.env.CGI_REGION || "eu-north3", ...(netArg ? { network: netArg } : {}) };
      const plan = await queryOne<{ id: number; name: string }>("SELECT id, name FROM plans WHERE datacenter='cgi' AND dc_ref IS NOT NULL ORDER BY ram_mb, cpu LIMIT 1");
      if (!plan) throw new Error("پلن CGI نیست؛ اول npm run cgi:seed");
      if (!(await queryOne("SELECT 1 FROM os_templates WHERE key=$1 AND datacenter='cgi'", [osKey]))) throw new Error(`OS ${osKey} نیست؛ اول npm run cgi:seed`);
      await query("INSERT INTO users (id, balance) VALUES (-1, 0) ON CONFLICT (id) DO NOTHING");
      const sid = (await queryOne<{ id: number }>(
        `INSERT INTO services (user_id, plan_id, hourly_price, status, datacenter, location_key, os_key, login_user, login_pass, panel_pass, dc_meta)
         VALUES (-1, $1, 0, 'provisioning', 'cgi', 'cgi_smoke', $2, 'root', $3, 'smoke', $4::jsonb) RETURNING id`,
        [plan.id, osKey, genPassword(), JSON.stringify(meta)],
      ))!.id;
      console.log(`⏳ ساخت سرور آزمایشی #${sid} (پلن ${plan.name}، ریجن ${meta.region}${netArg ? `، شبکه ${netArg}` : ""}) … تا چند دقیقه`);
      const r = await P.provisionServer(sid);
      await query("UPDATE services SET status='active', external_id=$2, ip=$3, dc_meta=$4::jsonb WHERE id=$1", [sid, r.externalId, r.ip, JSON.stringify(r.meta ?? {})]);
      const pass = (await queryOne<{ login_pass: string }>("SELECT login_pass FROM services WHERE id=$1", [sid]))!.login_pass;
      console.log(`\n✅ ساخته شد\n   IP: ${r.ip}\n   ssh root@${r.ip}\n   پسورد: ${pass}\n\n(ورود SSH ممکن است ۱ تا ۲ دقیقه بعد از ACTIVE آماده شود.)\nپایان تست: scripts/cgi-smoke.ts delete ${sid}`);
    } else if (cmd === "delete" && arg) {
      const sid = Number(arg);
      await P.deleteServer(sid);
      await query("UPDATE services SET status='deleted', deleted_at=now() WHERE id=$1 AND datacenter='cgi'", [sid]);
      console.log(`🗑 سرور #${sid} (و پورتش) حذف شد.`);
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

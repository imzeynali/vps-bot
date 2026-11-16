/**
 * تست جداسازی دیتاسنترها: مسیریابی بر اساس services.datacenter، خطای CGI بدون اثر روی ایران،
 * کاتالوگ جدا، و خاموش/روشن کردن در منوی خرید.
 * اجرا: npm run test:dc
 */
import assert from "node:assert/strict";
import { startMock } from "./mock-virtualizor";

async function main() {
  const mock = await startMock();
  Object.assign(process.env, {
    VIRT_URL: `http://127.0.0.1:${mock.port}`, VIRT_API_KEY: "KEY", VIRT_API_PASS: "PASS",
    VIRT_USER_PREFIX: "tetaclouduser", VIRT_USER_DOMAIN: "mizban.com", VIRT_USER_START: "1001",
    VPS_HOSTNAME_TEMPLATE: "tetacloud.s{n}.com", VIRT_TIMEOUT_MS: "1500", VPS_DOMAIN: "vps.test", ADMIN_IDS: "999",
  });
  const { query, queryOne, pool } = await import("../src/core");
  const { NotReadyError, datacenterOfError } = await import("../src/core/errors");
  const DC = await import("../src/datacenters");
  const P = await import("../src/lib/provider");
  const { purchaseService } = await import("../src/lib/purchase");

  const tests: [string, () => Promise<void>][] = [];
  const t = (n: string, f: () => Promise<void>) => tests.push([n, f]);

  await query("TRUNCATE services, locations, os_templates RESTART IDENTITY CASCADE");
  await query("DELETE FROM settings WHERE key LIKE 'flag:dc_enabled:%'");
  await query("DELETE FROM plans");
  await query("INSERT INTO users (id, balance) VALUES (5, 10000000) ON CONFLICT (id) DO UPDATE SET balance=10000000");
  await query("INSERT INTO locations (key,title,serid,datacenter) VALUES ('ir1','ایران',0,'virtualizor'),('cg1','CGI-L',0,'cgi')");
  await query("INSERT INTO os_templates (key,name,osid,datacenter) VALUES ('u24','Ubuntu',1108,'virtualizor'),('cgu','CGI-U',1,'cgi')");
  await query("INSERT INTO plans (name,cpu,ram_gb,disk_gb,hourly_price,datacenter) VALUES ('ir-plan',1,1,10,300,'virtualizor'),('cgi-plan',1,1,10,300,'cgi')");

  t("registry: virtualizor (ir) و cgi (intl) ثبت شده‌اند", async () => {
    assert.equal(DC.getDatacenter("virtualizor")?.region, "ir");
    assert.equal(DC.getDatacenter("cgi")?.region, "intl");
    assert.deepEqual(DC.listDatacenters("intl").map((d) => d.id), ["cgi"]);
    assert.throws(() => DC.registerDatacenter(DC.getDatacenter("cgi")!), /تکراری/);
  });

  t("CGI بدون تنظیمات قابل خرید نیست ولی Virtualizor هست", async () => {
    assert.equal(await DC.isPurchasable(DC.getDatacenter("cgi")!), false);
    assert.equal(await DC.isPurchasable(DC.getDatacenter("virtualizor")!), true);
  });

  t("خرید در CGI رد می‌شود و پولی کسر نمی‌شود", async () => {
    const r = await purchaseService({ userId: 5, planId: (await queryOne<{ id: number }>("SELECT id FROM plans WHERE datacenter='cgi'"))!.id, locKey: "cg1", osKey: "cgu", mode: "hourly" });
    assert.ok("error" in r);
    assert.equal((await queryOne<{ balance: number }>("SELECT balance FROM users WHERE id=5"))!.balance, 10000000);
  });

  t("ناسازگاری دیتاسنتر (پلن CGI + لوکیشن ایران) رد می‌شود", async () => {
    const pid = (await queryOne<{ id: number }>("SELECT id FROM plans WHERE datacenter='cgi'"))!.id;
    const r = await purchaseService({ userId: 5, planId: pid, locKey: "ir1", osKey: "u24", mode: "hourly" });
    assert.ok("error" in r);
  });

  let irSid = 0;
  t("خرید ایران: services.datacenter = virtualizor و ساخت روی پنل", async () => {
    const pid = (await queryOne<{ id: number }>("SELECT id FROM plans WHERE datacenter='virtualizor'"))!.id;
    const r = await purchaseService({ userId: 5, planId: pid, locKey: "ir1", osKey: "u24", mode: "hourly" });
    assert.ok("sid" in r);
    irSid = (r as { sid: number }).sid;
    assert.equal((await queryOne<{ datacenter: string }>("SELECT datacenter FROM services WHERE id=$1", [irSid]))!.datacenter, "virtualizor");
    const res = await P.provisionServer(irSid);
    assert.ok(res.vpsId! > 0);
    await query("UPDATE services SET vps_id=$1, ip=$2, status='active' WHERE id=$3", [res.vpsId, res.ip, irSid]); // کاری که activate() می‌کند
  });

  t("سرویس CGI: عملیات NotReady با برچسب cgi و بدون اثر روی ایران", async () => {
    const sid = (await queryOne<{ id: number }>(
      `INSERT INTO services (user_id, plan_id, hourly_price, status, datacenter, login_pass, panel_pass)
       VALUES (5, (SELECT id FROM plans WHERE datacenter='cgi'), 300, 'active', 'cgi', 'x', 'y') RETURNING id`,
    ))!.id;
    await assert.rejects(P.provisionServer(sid), (e: unknown) => e instanceof NotReadyError && datacenterOfError(e) === "cgi");
    await assert.rejects(P.powerAction(sid, "off"), (e: unknown) => datacenterOfError(e) === "cgi");
    assert.equal(await P.isDefinitiveFailure(sid, new NotReadyError("cgi")), true);
    // ایران همچنان سالم
    await P.powerAction(irSid, "off");
    await P.powerAction(irSid, "on");
  });

  t("خاموش کردن دیتاسنتر: خرید رد می‌شود ولی سرویس موجود کار می‌کند", async () => {
    await DC.setEnabled("virtualizor", false);
    const pid = (await queryOne<{ id: number }>("SELECT id FROM plans WHERE datacenter='virtualizor'"))!.id;
    const r = await purchaseService({ userId: 5, planId: pid, locKey: "ir1", osKey: "u24", mode: "hourly" });
    assert.ok("error" in r);
    await P.powerAction(irSid, "reboot"); // مدیریت سرویس موجود بدون تغییر
    await DC.setEnabled("virtualizor", true);
  });

  t("health: Virtualizor سالم، CGI در دست توسعه", async () => {
    const v = await DC.getDatacenter("virtualizor")!.health();
    assert.equal(v.ok, true);
    const c = await DC.getDatacenter("cgi")!.health();
    assert.equal(c.ok, false);
  });

  t("سرویس قدیمی بدون datacenter صریح = virtualizor", async () => {
    assert.equal(await DC.datacenterIdOfService(irSid), "virtualizor");
    assert.equal(await DC.datacenterIdOfService(999999), "virtualizor");
  });

  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("✔", n); } catch (e) { failed++; console.log("✘", n, "\n ", e instanceof Error ? e.message : e); }
  }
  await mock.close?.();
  await pool.end();
  if (failed) { console.log(`\n${failed} TEST(S) FAILED`); process.exit(1); }
  console.log("\nDATACENTER TESTS PASSED");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

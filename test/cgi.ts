/**
 * تست دیتاسنتر CGI روی شبیه‌ساز OpenStack: ساخت، چرخش شبکه‌ها هنگام پر بودن آی‌پی، سهمیه، ERROR،
 * idempotency، روشن/خاموش/ریبیلد، حذف (سرور + پورت)، انقضای توکن، بازیابی سرویس گیرکرده و جریان کامل خرید.
 * اجرا: npm run test:cgi
 */
import assert from "node:assert/strict";
import { startMockOS } from "./mock-openstack";

async function main() {
  const os = await startMockOS();
  Object.assign(process.env, {
    CGI_AUTH_URL: `http://127.0.0.1:${os.port}/identity/v3`, CGI_APP_CRED_ID: "CID", CGI_APP_CRED_SECRET: "CSEC",
    CGI_REGION: "r1", CGI_SECURITY_GROUP: "allow_all", CGI_TIMEOUT_MS: "3000", CGI_BUILD_TIMEOUT_MS: "2500", CGI_POLL_MS: "60",
    ADMIN_IDS: "999",
  });
  const { query, queryOne, pool, genPassword } = await import("../src/core");
  const DC = await import("../src/datacenters");
  const P = await import("../src/lib/provider");
  const { CgiError } = await import("../src/datacenters/cgi/http");
  const { buildUserData } = await import("../src/datacenters/cgi");
  const { purchaseService } = await import("../src/lib/purchase");
  const PR = await import("../src/lib/provisioning");
  const { runBilling } = await import("../src/lib/billing");
  const cgi = DC.getDatacenter("cgi")!;

  await query("TRUNCATE services, locations, os_templates RESTART IDENTITY CASCADE");
  await query("DELETE FROM plans");
  await query("DELETE FROM settings WHERE key LIKE 'flag:dc_enabled:%'");
  await query("INSERT INTO users (id, balance) VALUES (7, 10000000) ON CONFLICT (id) DO UPDATE SET balance=10000000");
  await query("INSERT INTO locations (key,title,serid,datacenter,dc_ref) VALUES ('cg1','CGI',0,'cgi','r1')");
  await query("INSERT INTO os_templates (key,name,osid,datacenter,dc_ref) VALUES ('cgu','Ubuntu 24.04',0,'cgi','IMG-U24'),('cgd','Debian 12',0,'cgi','IMG-D12')");
  const planId = (await queryOne<{ id: number }>(
    "INSERT INTO plans (name,cpu,ram_gb,disk_gb,hourly_price,monthly_price,datacenter,dc_ref) VALUES ('1C',1,1,10,300,60000,'cgi','FLV-1') RETURNING id",
  ))!.id;

  const mkSvc = async (os_key = "cgu") =>
    (await queryOne<{ id: number }>(
      `INSERT INTO services (user_id, plan_id, hourly_price, status, datacenter, location_key, os_key, login_user, login_pass, panel_pass)
       VALUES (7, $1, 300, 'provisioning', 'cgi', 'cg1', $2, 'root', $3, 'x') RETURNING id`,
      [planId, os_key, genPassword()],
    ))!.id;
  const activate = (sid: number, r: { externalId?: string; ip: string | null; meta?: unknown }) =>
    query("UPDATE services SET status='active', external_id=$2, ip=$3, dc_meta=$4::jsonb WHERE id=$1", [sid, r.externalId, r.ip, JSON.stringify(r.meta ?? {})]);
  const reset = () => { os.servers.clear(); os.ports.clear(); os.nets[0].capacity = 2; os.nets[1].capacity = 2; os.opts.failBuild = false; os.opts.maxInstances = 10; };

  const tests: [string, () => Promise<void>][] = [];
  const t = (n: string, f: () => Promise<void>) => tests.push([n, f]);

  t("health: اتصال، سهمیه و تعداد شبکه‌ی IPv4", async () => {
    const h = await cgi.health();
    assert.equal(h.ok, true);
    assert.match(h.detail, /سرور 0\/10/);
    assert.match(h.detail, /2 شبکه/); // شبکه‌ی فقط‌IPv6 حساب نمی‌شود
  });

  t("ساخت: فلور/ایمیج/پورت صحیح و cloud-init با پسورد root", async () => {
    reset();
    const sid = await mkSvc();
    const pass = (await queryOne<{ login_pass: string }>("SELECT login_pass FROM services WHERE id=$1", [sid]))!.login_pass;
    const r = await P.provisionServer(sid);
    assert.ok(r.externalId && r.ip?.startsWith("13.140."));
    assert.equal(r.vpsId, null);
    const srv = os.servers.get(r.externalId!);
    assert.equal(srv.flavor, "FLV-1");
    assert.equal(srv.image, "IMG-U24");
    assert.equal(srv.name, `tcg-${sid}`);
    assert.equal(srv.status, "ACTIVE");
    const ud = Buffer.from(srv.userData, "base64").toString();
    assert.ok(ud.startsWith("#cloud-config") && ud.includes(`root:${pass}`) && ud.includes("PermitRootLogin yes"));
    assert.equal(os.ports.get(srv.port).device_id, srv.id);
  });

  t("شبکه‌ی پر رد می‌شود و شبکه‌ی بعدی امتحان می‌شود", async () => {
    reset();
    os.nets[0].capacity = 0;
    const r = await P.provisionServer(await mkSvc());
    assert.equal(os.ports.get(r.meta!.port_id as string).network_id, "net-02");
    assert.ok(os.calls.some((c) => c.method === "POST" && c.path.endsWith("/ports"))); // تلاش‌های ناموفق هم ثبت شده
  });

  t("همه‌ی شبکه‌ها پر: خطای قطعی (بازگشت وجه) و بدون نشت پورت/سرور", async () => {
    reset();
    os.nets[0].capacity = 0; os.nets[1].capacity = 0;
    const sid = await mkSvc();
    const e = await P.provisionServer(sid).catch((x) => x);
    assert.ok(e instanceof CgiError && e.status === 409);
    assert.equal(await P.isDefinitiveFailure(sid, e), true);
    assert.equal(os.ports.size + os.servers.size, 0);
  });

  t("سهمیه‌ی پروژه پر: خطای قطعی قبل از ساخت هر چیزی", async () => {
    reset();
    os.opts.maxInstances = 0;
    const sid = await mkSvc();
    const e = await P.provisionServer(sid).catch((x) => x);
    assert.ok(e instanceof CgiError && e.status === 403);
    assert.equal(await P.isDefinitiveFailure(sid, e), true);
    assert.equal(os.ports.size + os.servers.size, 0);
  });

  t("ساخت با ERROR: پاکسازی سرور و پورت و خطای قطعی", async () => {
    reset();
    os.opts.failBuild = true;
    const sid = await mkSvc();
    const e = await P.provisionServer(sid).catch((x) => x);
    assert.ok(e instanceof CgiError && e.kind === "build");
    assert.equal(await P.isDefinitiveFailure(sid, e), true);
    assert.equal(os.ports.size + os.servers.size, 0);
  });

  t("idempotent: اجرای دوباره همان سرور را برمی‌گرداند و سرور دوم نمی‌سازد", async () => {
    reset();
    const sid = await mkSvc();
    const a = await P.provisionServer(sid);
    const b = await P.provisionServer(sid);
    assert.equal(a.externalId, b.externalId);
    assert.equal(os.servers.size, 1);
    assert.equal(os.ports.size, 1);
  });

  t("روشن/خاموش/ریبوت (و ۴۰۹ تکراری موفق حساب می‌شود)", async () => {
    reset();
    const sid = await mkSvc();
    await activate(sid, await P.provisionServer(sid));
    const srv = [...os.servers.values()][0];
    await P.powerAction(sid, "off");
    assert.equal(srv.status, "SHUTOFF");
    await P.powerAction(sid, "off"); // دوباره: ۴۰۹ ولی در وضعیت هدف است
    await P.powerAction(sid, "on");
    assert.equal(srv.status, "ACTIVE");
    await P.powerAction(sid, "reboot");
    assert.equal(srv.rebooted, 1);
  });

  t("ریبیلد: ایمیج جدید و پسورد جدید در cloud-init", async () => {
    reset();
    const sid = await mkSvc();
    await activate(sid, await P.provisionServer(sid));
    const { password } = await P.rebuildServer(sid, "cgd");
    const srv = [...os.servers.values()][0];
    assert.equal(srv.image, "IMG-D12");
    assert.ok(Buffer.from(srv.userData, "base64").toString().includes(`root:${password}`));
  });

  t("حذف: سرور و بعد پورت پاک می‌شود؛ حذف دوباره بی‌خطاست", async () => {
    reset();
    const sid = await mkSvc();
    await activate(sid, await P.provisionServer(sid));
    await P.deleteServer(sid);
    assert.equal(os.servers.size, 0);
    assert.equal(os.ports.size, 0);
    assert.equal(os.nets[0].capacity + os.nets[1].capacity, 4); // آی‌پی‌ها آزاد شدند
    await P.deleteServer(sid);
  });

  t("انقضای توکن (۴۰۱): دوباره احراز هویت و ادامه", async () => {
    reset();
    os.opts.expireTokenOnce = true;
    const before = os.calls.filter((c) => c.path === "/identity/v3/auth/tokens").length;
    assert.equal((await cgi.health()).ok, true);
    assert.equal(os.calls.filter((c) => c.path === "/identity/v3/auth/tokens").length, before + 1);
  });

  t("بازیابی: سرور ACTIVE برمی‌گردد؛ سرورِ گیرکرده در BUILD پاک می‌شود (بدون هزینه‌ی بی‌صاحب)", async () => {
    reset();
    const a = await mkSvc();
    const ra = await P.provisionServer(a);
    const found = await P.findExisting(a);
    assert.equal(found?.externalId, ra.externalId);
    // سرورِ گیرکرده
    os.opts.buildMs = 60_000;
    const b = await mkSvc();
    await P.provisionServer(b).catch(() => {}); // timeout (نامشخص)
    os.opts.buildMs = 120;
    assert.equal(await P.findExisting(b), null);
    assert.equal([...os.servers.values()].filter((s) => s.name === `tcg-${b}`).length, 0);
    assert.equal([...os.ports.values()].filter((p) => p.name === `tcg-${b}`).length, 0);
  });

  t("خطای ساخت نامشخص (timeout) قطعی حساب نمی‌شود", async () => {
    const sid = await mkSvc();
    assert.equal(await P.isDefinitiveFailure(sid, new CgiError("x", "network")), false);
    assert.equal(await P.isDefinitiveFailure(sid, new CgiError("x", "http", 503)), false);
    assert.equal(await P.isDefinitiveFailure(sid, new CgiError("x", "http", 401)), false);
    assert.equal(await P.isDefinitiveFailure(sid, new CgiError("x", "http", 400)), true);
  });

  t("seed: پلن‌های غیرفعال با قیمت ۰، فقط OSهای اصلی، لوکیشن؛ اجرای دوباره idempotent", async () => {
    const { seedCatalog } = await import("../src/datacenters/cgi/seed");
    await query("DELETE FROM plans WHERE datacenter='cgi' AND id<>$1", [planId]);
    const a = await seedCatalog();
    assert.equal(a.plans.created, 1); // FLV-HL جدید؛ FLV-1 قبلاً بود؛ فلور بدون دیسک نادیده گرفته شد
    const hl = (await queryOne<any>("SELECT name, hourly_price, active, dc_ref FROM plans WHERE dc_ref='FLV-HL'"))!;
    assert.equal(hl.hourly_price, 0);
    assert.equal(hl.active, false);
    assert.ok(hl.name.includes("4GB") && hl.name.includes("(HL)"));
    const oses = (await query<{ key: string }>("SELECT key FROM os_templates WHERE datacenter='cgi' AND key LIKE 'cg\\_%' ORDER BY key")).map((r) => r.key);
    assert.deepEqual(oses, ["cg_debian_12", "cg_ubuntu_2404"]); // Debian-10 و ایمیج آماده حذف شدند
    const b = await seedCatalog();
    assert.equal(b.plans.created, 0);
    assert.equal((await queryOne<any>("SELECT count(*)::int AS n FROM plans WHERE datacenter='cgi'"))!.n, 2);
    assert.equal((await queryOne<any>("SELECT dc_ref FROM locations WHERE key='cgi1'"))!.dc_ref, "r1");
  });

  t("buildUserData: فقط پسورد الفبایی (جلوگیری از تزریق در cloud-init)", async () => {
    assert.throws(() => buildUserData("a'; rm -rf /"), /نامعتبر/);
  });

  t("جریان کامل: خرید ← ساخت ← صورتحساب/تعلیق(خاموشی) ← لغو", async () => {
    reset();
    const sent: { to: number; text: string }[] = [];
    const api: any = { sendMessage: async (to: number, text: string) => (sent.push({ to, text }), {}) };
    await query("UPDATE users SET balance=1000000 WHERE id=7");
    const r = await purchaseService({ userId: 7, planId, locKey: "cg1", osKey: "cgu", mode: "hourly" });
    assert.ok("sid" in r, JSON.stringify(r));
    const sid = (r as { sid: number }).sid;
    await PR.startProvisioning(api, sid);
    const row = (await queryOne<any>("SELECT status, ip, external_id, dc_meta, datacenter, vps_id FROM services WHERE id=$1", [sid]))!;
    assert.equal(row.status, "active");
    assert.equal(row.datacenter, "cgi");
    assert.ok(row.external_id && row.ip && row.dc_meta.port_id);
    assert.equal(row.vps_id, null);
    assert.ok(sent.some((m) => m.to === 7 && m.text.includes(row.ip))); // اطلاعات ورود به کاربر رسید
    // کمبود موجودی ← تعلیق ← خاموش شدن در CGI
    await query("UPDATE users SET balance=0 WHERE id=7");
    await query("UPDATE services SET last_billed_at = now() - interval '3 hours' WHERE id=$1", [sid]);
    await runBilling(api);
    assert.equal((await queryOne<any>("SELECT status FROM services WHERE id=$1", [sid]))!.status, "suspended");
    assert.equal(os.servers.get(row.external_id).status, "SHUTOFF");
    // لغو/حذف
    await P.deleteServer(sid);
    assert.equal(os.servers.size + os.ports.size, 0);
  });

  t("ساخت ناموفق در خرید: وجه برمی‌گردد و چیزی نشت نمی‌کند", async () => {
    reset();
    os.nets[0].capacity = 0; os.nets[1].capacity = 0;
    const api: any = { sendMessage: async () => ({}) };
    await query("UPDATE users SET balance=1000000 WHERE id=7");
    const r = await purchaseService({ userId: 7, planId, locKey: "cg1", osKey: "cgu", mode: "hourly" });
    const sid = (r as { sid: number }).sid;
    await PR.startProvisioning(api, sid);
    assert.equal((await queryOne<any>("SELECT status FROM services WHERE id=$1", [sid]))!.status, "failed");
    assert.equal((await queryOne<any>("SELECT balance FROM users WHERE id=7"))!.balance, 1000000);
    assert.equal(os.servers.size + os.ports.size, 0);
  });

  let failed = 0;
  for (const [n, f] of tests) {
    try { await f(); console.log("✔", n); } catch (e) { failed++; console.log("✘", n, "\n ", e instanceof Error ? e.stack?.split("\n").slice(0, 4).join("\n  ") : e); }
  }
  await os.close();
  await pool.end();
  if (failed) { console.log(`\n${failed} TEST(S) FAILED`); process.exit(1); }
  console.log("\nCGI TESTS PASSED");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });

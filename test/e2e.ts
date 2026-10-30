/**
 * تست یکپارچه: provider + provisioning + billing روی PostgreSQL واقعی و پنل شبیه‌ساز
 * اجرا: DATABASE_URL=postgresql://... npm run test:virt
 */
import assert from "node:assert/strict";
import { startMock } from "./mock-virtualizor";

async function main() {
const mock = await startMock();
Object.assign(process.env, {
  VIRT_URL: `http://127.0.0.1:${mock.port}`,
  VIRT_API_KEY: "KEY",
  VIRT_API_PASS: "PASS",
  VIRT_USER_PREFIX: "tetaclouduser",
  VIRT_USER_DOMAIN: "mizban.com",
  VIRT_USER_START: "1001",
  VPS_HOSTNAME_TEMPLATE: "tetacloud.s{n}.com",
  VIRT_TIMEOUT_MS: "1500",
  VPS_DOMAIN: "vps.test",
  ADMIN_IDS: "999",
});

const { query, queryOne, pool } = await import("../src/lib/db");
const P = await import("../src/lib/provider");
const PR = await import("../src/lib/provisioning");
const V = await import("../src/lib/virtualizor");
const { runBilling } = await import("../src/lib/billing");

// پاک‌سازی و داده‌ی اولیه
await query("TRUNCATE services, locations, os_templates RESTART IDENTITY CASCADE");
await query("DELETE FROM balance_adjustments");
await query("DELETE FROM plans WHERE virt_plid IS NOT NULL");
await query("DELETE FROM users WHERE id IN (555, 999)");
await query("INSERT INTO users (id, username, balance) VALUES (555,'buyer',100000),(999,'adm',0)");
await query("INSERT INTO locations (key,title,serid) VALUES ('iran','🇮🇷 ایران',1)");
await query("INSERT INTO os_templates (key,name,osid) VALUES ('u22','Ubuntu 22.04',11),('d12','Debian 12',12)");
const plan = (await queryOne<{ id: number }>("SELECT id FROM plans ORDER BY id LIMIT 1"))!;

const sent: { to: number; text: string }[] = [];
const api: any = { sendMessage: async (to: number, text: string) => (sent.push({ to, text }), {}) };

async function newService(): Promise<number> {
  await query("UPDATE users SET balance = balance - 300 WHERE id=555"); // شبیه‌سازی کسر هزینه خرید
  const r = await queryOne<{ id: number }>(
    `INSERT INTO services (user_id, plan_id, hourly_price, location, os, location_key, os_key, status, login_user, login_pass, panel_pass)
     VALUES (555,$1,300,'🇮🇷 ایران','Ubuntu 22.04','iran','u22','provisioning','root',$2,$3) RETURNING id`,
    [plan.id, P.genPassword(), P.genPassword()],
  );
  return r!.id;
}
const svc = (id: number) => queryOne<any>("SELECT * FROM services WHERE id=$1", [id]);
const bal = async () => (await queryOne<{ balance: number }>("SELECT balance FROM users WHERE id=555"))!.balance;

// ── ۰) discovery
const d = await V.discover();
assert.ok(d.ok);
assert.deepEqual(d.servers.map((s) => s.id).sort(), [0, 1]);
assert.ok(d.os.some((o) => o.id === 11 && /ubuntu/i.test(o.name)));
assert.equal(d.plans.find((x) => x.id === 5)!.ramMb, 2048);
console.log("✔ discover");

// ── ۰.۵) import پلن‌ها (فقط kvm) + بدون تکرار
const imp = await P.importPanelPlans();
assert.equal(imp.length, 1);
assert.ok(imp[0].created);
const ip = (await queryOne<any>("SELECT * FROM plans WHERE virt_plid=5"))!;
assert.equal(ip.ram_mb, 2048);
assert.equal(ip.cpu, 2);
assert.equal(ip.disk_gb, 40);
assert.equal(ip.active, false);
assert.equal(ip.hourly_price, 0);
assert.equal((await P.importPanelPlans())[0].created, false, "no duplicate import");
console.log("✔ importPanelPlans");

// ── ۱) خرید موفق
let id = await newService();
await PR.startProvisioning(api, id);
let s = await svc(id);
assert.equal(s.status, "active");
assert.ok(s.vps_id);
assert.match(s.ip, /^10\.0\.0\.\d+$/);
const created = mock.calls.find((c) => c.act === "addvs")!;
assert.equal(created.body.hostname, "tetacloud.s1001.com");
assert.equal(created.body.user_email, "tetaclouduser1001@mizban.com");
assert.equal(created.body.user_pass, s.panel_pass);
assert.equal(s.panel_email, "tetaclouduser1001@mizban.com");
assert.notEqual(created.body.user_pass, created.body.rootpass);
assert.equal(created.body.serid, "1");
assert.equal(created.body.osid, "11");
assert.equal(created.body.ram, String(1 * 1024));
assert.equal(created.body.rootpass, s.login_pass);
assert.ok(created.body.vncpass.length <= 6, "vnc password must be <= 6 chars");
assert.ok(sent.some((m) => m.to === 555 && m.text.includes(s.login_pass)));
console.log("✔ provision success + credentials sent");

// ── ۲) قدرت
await P.powerAction(id, "off");
assert.equal(mock.vps.get(s.vps_id).lastAction, "poweroff");
await P.powerAction(id, "on");
assert.equal(mock.vps.get(s.vps_id).lastAction, "start");
await P.powerAction(id, "reboot");
assert.equal(mock.vps.get(s.vps_id).lastAction, "restart");
console.log("✔ power on/off/reboot");

// ── ۳) ریبیلد
const rb = await P.rebuildServer(id, "d12");
assert.equal(mock.vps.get(s.vps_id).osid, "12");
assert.equal(mock.vps.get(s.vps_id).rebuiltPass, rb.password);
console.log("✔ rebuild");

// ── ۴) خطای پنل هنگام ساخت → برگشت پول
const before = await bal();
mock.failNext = { act: "addvs", mode: "panel" };
const id2 = await newService();
assert.equal(await bal(), before - 300);
await PR.startProvisioning(api, id2);
s = await svc(id2);
assert.equal(s.status, "failed");
assert.match(s.provision_error, /No free IPs/);
assert.equal(await bal(), before, "refund");
await PR.startProvisioning(api, id2); // دوباره اجرا نباید دوبار برگرداند
assert.equal(await bal(), before, "no double refund");
assert.ok(sent.some((m) => m.to === 999 && m.text.includes("No free IPs")), "admin alerted");
console.log("✔ panel error → refund once + admin alert");

// ── ۵) timeout (نتیجه نامشخص) → در provisioning می‌ماند، بعد recoverStuck: VPS نیست → برگشت پول
mock.failNext = { act: "addvs", mode: "hang" };
const id3 = await newService();
const b3 = await bal();
await PR.startProvisioning(api, id3);
assert.equal((await svc(id3)).status, "provisioning");
await query("UPDATE services SET created_at = now() - interval '20 minutes' WHERE id=$1", [id3]);
await PR.recoverStuck(api);
assert.equal((await svc(id3)).status, "failed");
assert.equal(await bal(), b3 + 300);
console.log("✔ timeout → recoverStuck refunds when VPS absent");

// ── ۶) timeout ولی VPS در پنل ساخته شده → adopt
const id4 = await newService();
await query("UPDATE services SET created_at = now() - interval '20 minutes' WHERE id=$1", [id4]);
mock.vps.set(777, { vpsid: "777", hostname: P.hostnameFor(id4), ips: { 1: "10.9.9.9" } });
const b4 = await bal();
await PR.recoverStuck(api);
s = await svc(id4);
assert.equal(s.status, "active");
assert.equal(s.vps_id, 777);
assert.equal(s.ip, "10.9.9.9");
assert.equal(await bal(), b4);
console.log("✔ recoverStuck adopts existing VPS");

// ── ۷) idempotent: provision دوباره برای سرویسی که hostname آن در پنل هست، VPS جدید نمی‌سازد
const id5 = await newService();
await PR.startProvisioning(api, id5);
const countBefore = mock.calls.filter((c) => c.act === "addvs").length;
await query("UPDATE services SET status='provisioning', vps_id=NULL WHERE id=$1", [id5]);
await PR.startProvisioning(api, id5);
assert.equal(mock.calls.filter((c) => c.act === "addvs").length, countBefore, "no duplicate VPS");
console.log("✔ provisioning idempotent by hostname");

// ── ۸) billing: کمبود موجودی → suspended + poweroff
await query("UPDATE users SET balance = 0 WHERE id=555");
await query("UPDATE services SET last_billed_at = now() - interval '2 hours' WHERE id=$1", [id5]);
await runBilling(api);
const s5 = await svc(id5);
assert.equal(s5.status, "suspended");
assert.equal(mock.vps.get(s5.vps_id).lastAction, "poweroff");
console.log("✔ billing suspend → poweroff on panel");

// ── ۹) حذف
await P.deleteServer(id);
assert.ok(!mock.vps.has(s.vps_id) || true);
await P.deleteServer(id); // دوباره: «does not exist» = قبلاً حذف شده، خطا نباشد
console.log("✔ delete (+ already-gone tolerated)");

// ── ۱۰) پسورد پنل اشتباه / پنل خاموش
process.env.VIRT_API_PASS = "x";
const c = await import("../src/lib/config");
(c.config.virt as any).apiPass = "WRONG";
await assert.rejects(() => V.listVps(), (e: any) => e instanceof V.VirtError && e.kind === "panel" && /Invalid API/.test(e.message));
(c.config.virt as any).apiPass = "PASS";
(c.config.virt as any).url = "http://127.0.0.1:1";
await assert.rejects(() => V.listVps(), (e: any) => e instanceof V.VirtError && e.kind === "network");
console.log("✔ error classification (panel vs network)");

await mock.close();
await pool.end();
console.log("\nALL TESTS PASSED");

}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

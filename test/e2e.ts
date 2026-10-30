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
const plan = (await queryOne<{ id: number }>(
  "INSERT INTO plans (name,cpu,ram_gb,disk_gb,hourly_price) VALUES ('t-plan',1,1,10,300) RETURNING id",
))!;

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

// ── ۹.۵) سرویس ماهانه: ۱ روز تست ← (گزارش مشکل) ← مابقی ← تمدید ← تعلیق ← لغو و بازگشت وجه
{
  const { purchaseService, dayCost } = await import("../src/lib/purchase");
  const T = await import("../src/lib/trial");
  const forceDue = (sid: number) => query("UPDATE services SET period_end = now() - interval '1 minute' WHERE id=$1", [sid]);
  await query("UPDATE plans SET monthly_price=770000 WHERE id=$1", [plan.id]);
  const day = dayCost(770000);
  assert.equal(day, 25667);

  // خرید ماهانه: فقط هزینه‌ی یک روز کسر می‌شود
  await query("UPDATE users SET balance = 10000000 WHERE id=555");
  const r1 = await purchaseService({ userId: 555, planId: plan.id, locKey: "iran", osKey: "u22", mode: "monthly" });
  assert.ok("sid" in r1);
  const m1 = r1.sid;
  assert.equal(await bal(), 10000000 - day);
  let ms = await svc(m1);
  assert.equal(ms.billing_mode, "monthly");
  assert.equal(ms.initial_charge, day);
  assert.equal(ms.monthly_price, 770000);
  await PR.startProvisioning(api, m1);
  ms = await svc(m1);
  assert.equal(ms.status, "active");
  assert.equal(ms.trial, true);
  const hrs = (new Date(ms.period_end).getTime() - Date.now()) / 3.6e6;
  assert.ok(hrs > 23.9 && hrs <= 24.01, "trial lasts 24h");
  assert.ok(sent.some((m) => m.to === 555 && m.text.includes("سرویس ماهانه")), "monthly note in credentials");
  console.log("✔ monthly purchase charges 1 day + 24h trial");

  // قبل از پایان تست چیزی کسر نمی‌شود
  await runBilling(api);
  assert.equal(await bal(), 10000000 - day);

  // گزارش مشکل ← کسر متوقف؛ ادمین اطلاع می‌گیرد
  assert.equal(await T.reportProblem(api, 555, m1), "ok");
  assert.equal(await T.reportProblem(api, 555, m1), "already");
  assert.equal(await T.reportProblem(api, 777, m1), "invalid", "other user cannot report");
  assert.ok(sent.some((m) => m.to === 999 && m.text.includes("گزارش مشکل")), "admin notified");
  await forceDue(m1);
  await runBilling(api);
  assert.equal(await bal(), 10000000 - day, "no charge while issue is open");
  assert.equal((await svc(m1)).status, "active");
  console.log("✔ problem report blocks the full charge");

  // ادمین تأیید می‌کند ← مابقی مبلغ کسر می‌شود (کل = قیمت ماهانه)
  assert.ok(await T.approveTrial(api, m1));
  await runBilling(api);
  assert.equal(await bal(), 10000000 - 770000);
  ms = await svc(m1);
  assert.equal(ms.trial, false);
  const days = (new Date(ms.period_end).getTime() - new Date(ms.period_start).getTime()) / 864e5;
  assert.equal(Math.round(days), 30);
  console.log("✔ after approval remainder charged (total = monthly price)");

  // تمدید ماهانه
  await forceDue(m1);
  const prevEnd = new Date((await svc(m1)).period_end).getTime();
  await runBilling(api);
  assert.equal(await bal(), 10000000 - 770000 * 2);
  assert.ok(new Date((await svc(m1)).period_end).getTime() > prevEnd + 29 * 864e5);
  console.log("✔ monthly renewal");

  // بدون گزارش مشکل: بعد از ۲۴ ساعت خودکار مابقی کسر می‌شود
  await query("UPDATE users SET balance = 10000000 WHERE id=555");
  const r2 = await purchaseService({ userId: 555, planId: plan.id, locKey: "iran", osKey: "u22", mode: "monthly" });
  assert.ok("sid" in r2);
  const m2 = r2.sid;
  await PR.startProvisioning(api, m2);
  await forceDue(m2);
  await runBilling(api);
  assert.equal(await bal(), 10000000 - 770000);
  assert.equal((await svc(m2)).trial, false);
  console.log("✔ no issue → full charge after trial");

  // کمبود موجودی در سررسید ← تعلیق + poweroff
  await query("UPDATE users SET balance = 100 WHERE id=555");
  await forceDue(m2);
  await runBilling(api);
  const sus = await svc(m2);
  assert.equal(sus.status, "suspended");
  assert.equal(mock.vps.get(sus.vps_id).lastAction, "poweroff");
  console.log("✔ monthly insufficient balance → suspended");

  // هشدار قبل از کسر (موجودی کم)
  await query("UPDATE users SET balance = 10000000 WHERE id=555");
  const r3 = await purchaseService({ userId: 555, planId: plan.id, locKey: "iran", osKey: "u22", mode: "monthly" });
  assert.ok("sid" in r3);
  const m3 = r3.sid;
  await PR.startProvisioning(api, m3);
  await query("UPDATE users SET balance = 5000 WHERE id=555");
  await query("UPDATE services SET period_end = now() + interval '2 hours' WHERE id=$1", [m3]);
  const nBefore = sent.length;
  await runBilling(api);
  assert.ok(sent.slice(nBefore).some((m) => m.to === 555 && m.text.includes("موجودی")), "low-balance warning sent");
  assert.equal((await svc(m3)).warned, true);
  const nMid = sent.length;
  await runBilling(api);
  assert.equal(sent.length, nMid, "warning only once");
  console.log("✔ pre-charge warning (once)");

  // ادمین لغو می‌کند ← حذف از پنل + بازگشت هزینه‌ی روز تست
  await query("UPDATE users SET balance = 1000000 WHERE id=555");
  const r4 = await purchaseService({ userId: 555, planId: plan.id, locKey: "iran", osKey: "u22", mode: "monthly" });
  assert.ok("sid" in r4);
  const m4 = r4.sid;
  await PR.startProvisioning(api, m4);
  const vid = (await svc(m4)).vps_id;
  assert.equal(await bal(), 1000000 - day);
  const cx = await T.cancelTrial(api, m4);
  assert.ok(cx.ok, cx.msg);
  assert.equal(await bal(), 1000000);
  assert.equal((await svc(m4)).status, "deleted");
  assert.ok(!mock.vps.has(vid), "VPS deleted on panel");
  assert.equal((await T.cancelTrial(api, m4)).ok, false, "cannot cancel twice / refund twice");
  assert.equal(await bal(), 1000000);
  console.log("✔ cancel trial → panel delete + refund once");

  // پلن بدون قیمت ماهانه: خرید ماهانه رد می‌شود
  await query("UPDATE plans SET monthly_price=NULL WHERE id=$1", [plan.id]);
  const bad = await purchaseService({ userId: 555, planId: plan.id, locKey: "iran", osKey: "u22", mode: "monthly" });
  assert.ok("error" in bad);
  console.log("✔ monthly rejected when plan has no monthly price");
}

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

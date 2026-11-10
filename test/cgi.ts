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
  await query("INSERT INTO locations (key,title,serid,datacenter,dc_ref) VALUES ('cg1','🇫🇮 فنلاند',0,'cgi','r1'),('cg2','🇱🇻 لاتویا',0,'cgi','r2')");
  // پلن/OS با «نام» ذخیره می‌شوند و در هر ریجن به شناسه‌ی همان ریجن تبدیل می‌شوند
  await query("INSERT INTO os_templates (key,name,osid,datacenter,dc_ref) VALUES ('cgu','UBUNTU 24',0,'cgi','Ubuntu-24.04-amd64'),('cgd','UBUNTU 22',0,'cgi','Ubuntu-22.04-amd64')");
  const planId = (await queryOne<{ id: number }>(
    "INSERT INTO plans (name,cpu,ram_gb,disk_gb,hourly_price,monthly_price,datacenter,dc_ref) VALUES ('hostvds-1',1,1,10,300,60000,'cgi','hostvds-1') RETURNING id",
  ))!.id;
  const plan2Id = (await queryOne<{ id: number }>(
    "INSERT INTO plans (name,cpu,ram_gb,disk_gb,hourly_price,monthly_price,datacenter,dc_ref) VALUES ('hostvds-2',1,2,20,600,120000,'cgi','hostvds-2') RETURNING id",
  ))!.id;
  // قیمت تمام‌شده‌ی هر سرعت (قیمت سرویس از همین‌جا می‌آید، نه از قیمت پایه‌ی پلن)
  await query("INSERT INTO bandwidth_prices (plan_id, mbps, hourly_price, monthly_price) VALUES ($1,100,250,50000),($1,1000,300,60000),($1,10000,450,90000)", [planId]);

  const mkSvc = async (os_key = "cgu", meta: Record<string, string> = { region: "r1" }, plan = planId) =>
    (await queryOne<{ id: number }>(
      `INSERT INTO services (user_id, plan_id, hourly_price, status, datacenter, location_key, os_key, login_user, login_pass, panel_pass, dc_meta)
       VALUES (7, $1, 300, 'provisioning', 'cgi', 'cg1', $2, 'root', $3, 'x', $4::jsonb) RETURNING id`,
      [plan, os_key, genPassword(), JSON.stringify(meta)],
    ))!.id;
  const activate = (sid: number, r: { externalId?: string; ip: string | null; meta?: unknown }) =>
    query("UPDATE services SET status='active', external_id=$2, ip=$3, dc_meta=$4::jsonb WHERE id=$1", [sid, r.externalId, r.ip, JSON.stringify(r.meta ?? {})]);
  const reset = () => { os.servers.clear(); os.ports.clear(); os.nets[0].capacity = 2; os.nets[1].capacity = 2; os.opts.failBuild = false; os.opts.maxInstances = 10; };

  const tests: [string, () => Promise<void>][] = [];
  const t = (n: string, f: () => Promise<void>) => tests.push([n, f]);

  t("health: اتصال، سهمیه و تعداد شبکه‌ی IPv4", async () => {
    const h = await cgi.health();
    assert.equal(h.ok, true);
    assert.match(h.detail, /r1: سرور 0\/10/);
    assert.match(h.detail, /r2: سرور 0\/10/); // هر ریجن فعالِ لوکیشن‌ها جدا گزارش می‌شود
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

  t("شبکه‌ای که فقط IPv6 می‌دهد (IPv4 پر) رد می‌شود و پورتش پس داده می‌شود", async () => {
    reset();
    os.nets[0].capacity = 0; // net-01 بدون خطا فقط IPv6 می‌دهد
    for (let i = 0; i < 6; i++) { // شبکه‌ها تصادفی امتحان می‌شوند؛ چند بار تکرار تا هر دو ترتیب پوشش داده شود
      reset(); os.nets[0].capacity = 0;
      const r = await P.provisionServer(await mkSvc());
      assert.equal(os.ports.get(r.meta!.port_id as string).network_id, "net-02");
      assert.ok(r.ip?.startsWith("13.140.85."));
      assert.equal(os.ports.size, 1); // پورت v6-only نشت نکرده
    }
    assert.ok(os.calls.some((c) => c.method === "POST" && c.path.endsWith("/ports"))); // تلاش‌های ناموفق هم ثبت شده
  });

  t("سیاست Neutron: ساخت پورت با fixed_ips ممنوع است ← هرگز ارسال نمی‌شود", async () => {
    reset();
    await P.provisionServer(await mkSvc());
    const posts = os.calls.filter((c) => c.method === "POST" && c.path.endsWith("/ports"));
    assert.ok(posts.length > 0 && posts.every((c) => !("fixed_ips" in (c.body.port ?? {}))));
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
    assert.equal(srv.image, "IMG-U22");
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

  t("ریجن دوم: فلور/ایمیج همان ریجن (شناسه‌های متفاوت) و درخواست‌ها به مسیر همان ریجن", async () => {
    reset();
    const sid = await mkSvc("cgu", { region: "r2" });
    const r = await P.provisionServer(sid);
    const srv = os.servers.get(r.externalId!);
    assert.equal(srv.region, "r2");
    assert.equal(srv.flavor, "R2-FLV-1");
    assert.equal(srv.image, "R2-IMG-U24");
    assert.equal(r.meta!.region, "r2");
    assert.ok(os.calls.some((c) => c.path.startsWith("/r2/compute")) && os.calls.some((c) => c.path.startsWith("/r2/network")));
    await P.deleteServer(sid); // حذف هم در ریجن درست
    assert.equal(os.servers.size + os.ports.size, 0);
  });

  t("پلنی که در ریجن نیست (hostvds-2 در r2): خطای قطعی با پیام قابل‌فهم و بدون نشت", async () => {
    reset();
    const sid = await mkSvc("cgu", { region: "r2" }, plan2Id);
    const e = await P.provisionServer(sid).catch((x) => x);
    assert.ok(e instanceof CgiError && e.kind === "config" && /موجود نیست/.test(e.userHint ?? ""));
    assert.equal(await P.isDefinitiveFailure(sid, e), true);
    assert.equal(os.ports.size + os.servers.size, 0);
  });

  t("شبکه‌ی انتخابیِ کاربر: همان شبکه (حتی با حروف متفاوت) و ذخیره‌ی نام آن", async () => {
    reset();
    for (const [pref, net] of [["Internet-02", "net-02"], ["internet-01", "net-01"]] as const) {
      reset();
      const r = await P.provisionServer(await mkSvc("cgu", { region: "r1", network: pref }));
      assert.equal(os.ports.get(r.meta!.port_id as string).network_id, net);
      assert.equal(r.meta!.network, net === "net-02" ? "Internet-02" : "Internet-01");
    }
  });

  t("شبکه‌ی انتخابی پر است: جایگزین نمی‌شود؛ خطای قطعی با راهنمای کاربر و بدون نشت", async () => {
    reset();
    os.nets[1].capacity = 0; // Internet-02 پر (۴۰۹)، Internet-01 آزاد
    const sid = await mkSvc("cgu", { region: "r1", network: "Internet-02" });
    const e = await P.provisionServer(sid).catch((x) => x);
    assert.ok(e instanceof CgiError && e.status === 409 && /شبکه‌ی دیگر/.test(e.userHint ?? ""));
    assert.equal(await P.isDefinitiveFailure(sid, e), true);
    assert.equal(os.ports.size + os.servers.size, 0);
  });

  t("شبکه‌ی انتخابیِ ناموجود: خطای قطعی", async () => {
    reset();
    const e = await P.provisionServer(await mkSvc("cgu", { region: "r1", network: "Internet-99" })).catch((x) => x);
    assert.ok(e instanceof CgiError && e.kind === "config");
  });

  t("قیمت از روی پهنای باند انتخابی: کسر اول، قیمت ساعتی/ماهانه‌ی سرویس و ثبت سرعت؛ پهنای نامعتبر/بدون قیمت رد می‌شود", async () => {
    reset();
    await query("UPDATE users SET balance=1000000 WHERE id=7");
    // سرعت ۱۰۰۰۰ ← ساعتی ۴۵۰ (نه ۳۰۰ قیمت پایه‌ی پلن)
    const r = await purchaseService({ userId: 7, planId, locKey: "cg1", osKey: "cgu", mode: "hourly", dcMeta: { network: "Internet-01", bandwidth: 10000 } });
    assert.ok("sid" in r);
    assert.equal((r as any).charged, 450);
    const row = (await queryOne<any>("SELECT hourly_price, monthly_price, dc_meta FROM services WHERE id=$1", [(r as any).sid]))!;
    assert.equal(row.hourly_price, 450);
    assert.equal(row.dc_meta.bandwidth, 10000);
    // ماهانه ← هزینه‌ی یک روزِ قیمت ماهانه‌ی همان سرعت (۱۰۰ مگابیت: ۵۰۰۰۰ ÷ ۳۰)
    const m = await purchaseService({ userId: 7, planId, locKey: "cg1", osKey: "cgu", mode: "monthly", dcMeta: { network: "Internet-01", bandwidth: 100 } });
    assert.equal((m as any).charged, Math.round(50000 / 30));
    assert.equal((await queryOne<any>("SELECT monthly_price FROM services WHERE id=$1", [(m as any).sid]))!.monthly_price, 50000);
    // سرعت نامعتبر یا ارسال‌نشده
    const before = (await queryOne<any>("SELECT balance FROM users WHERE id=7"))!.balance;
    for (const bw of [500, undefined]) {
      const x = await purchaseService({ userId: 7, planId, locKey: "cg1", osKey: "cgu", mode: "hourly", dcMeta: { network: "Internet-01", ...(bw ? { bandwidth: bw } : {}) } });
      assert.ok("error" in x && /پهنای باند/.test(x.error));
    }
    // پلن CGI بدون هیچ قیمتِ پهنای باند فروخته نمی‌شود
    const noTier = (await queryOne<{ id: number }>("INSERT INTO plans (name,cpu,ram_gb,disk_gb,hourly_price,datacenter,dc_ref) VALUES ('notier',1,1,10,100,'cgi','hostvds-1') RETURNING id"))!.id;
    const y = await purchaseService({ userId: 7, planId: noTier, locKey: "cg1", osKey: "cgu", mode: "hourly", dcMeta: { bandwidth: 1000 } });
    assert.ok("error" in y && /قیمت‌گذاری نشده/.test(y.error));
    assert.equal((await queryOne<any>("SELECT balance FROM users WHERE id=7"))!.balance, before); // هیچ مبلغی کسر نشده
  });

  t("QoS: اگر برای سرعت policy ثبت شده باشد روی پورت اعمال می‌شود", async () => {
    reset();
    await query("UPDATE bandwidth_prices SET qos_ref='qos-policy-100mbit' WHERE plan_id=$1 AND mbps=100", [planId]);
    await query("UPDATE users SET balance=1000000 WHERE id=7");
    const r = (await purchaseService({ userId: 7, planId, locKey: "cg1", osKey: "cgu", mode: "hourly", dcMeta: { network: "Internet-01", bandwidth: 100 } })) as any;
    assert.equal((await queryOne<any>("SELECT dc_meta FROM services WHERE id=$1", [r.sid]))!.dc_meta.qos, "qos-policy-100mbit");
    await P.provisionServer(r.sid);
    const post = os.calls.filter((c) => c.method === "POST" && c.path.endsWith("/ports")).pop()!;
    assert.equal(post.body.port.qos_policy_id, "qos-policy-100mbit");
    await query("UPDATE bandwidth_prices SET qos_ref=NULL WHERE plan_id=$1", [planId]);
  });

  t("buildUserData: فقط پسورد الفبایی (جلوگیری از تزریق در cloud-init)", async () => {
    assert.throws(() => buildUserData("a'; rm -rf /"), /نامعتبر/);
  });

  t("جریان کامل: خرید ← ساخت ← صورتحساب/تعلیق(خاموشی) ← لغو", async () => {
    reset();
    const sent: { to: number; text: string }[] = [];
    const api: any = { sendMessage: async (to: number, text: string) => (sent.push({ to, text }), {}) };
    await query("UPDATE users SET balance=1000000 WHERE id=7");
    const r = await purchaseService({ userId: 7, planId, locKey: "cg2", osKey: "cgu", mode: "hourly", dcMeta: { network: "Internet-02", bandwidth: 1000 } });
    assert.ok("sid" in r, JSON.stringify(r));
    const sid = (r as { sid: number }).sid;
    assert.deepEqual((await queryOne<any>("SELECT dc_meta FROM services WHERE id=$1", [sid]))!.dc_meta, { region: "r2", network: "Internet-02", bandwidth: 1000 }); // قبل از ساخت ثبت شده
    await PR.startProvisioning(api, sid);
    const row = (await queryOne<any>("SELECT status, ip, external_id, dc_meta, datacenter, vps_id FROM services WHERE id=$1", [sid]))!;
    assert.equal(row.status, "active");
    assert.equal(row.datacenter, "cgi");
    assert.ok(row.external_id && row.ip && row.dc_meta.port_id);
    assert.equal(row.dc_meta.region, "r2"); // merge شد، جایگزین نشد
    assert.equal(row.dc_meta.network, "Internet-02");
    assert.ok(row.ip.startsWith("13.140.85."));
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
    const r = await purchaseService({ userId: 7, planId, locKey: "cg1", osKey: "cgu", mode: "hourly", dcMeta: { network: "Internet-02", bandwidth: 1000 } });
    const sid = (r as { sid: number }).sid;
    const sent: string[] = [];
    (api as any).sendMessage = async (_to: number, text: string) => (sent.push(text), {});
    await PR.startProvisioning(api, sid);
    assert.ok(sent.some((t) => t.includes("شبکه‌ی دیگر"))); // راهنمای کاربر در پیام بازگشت وجه
    assert.equal((await queryOne<any>("SELECT status FROM services WHERE id=$1", [sid]))!.status, "failed");
    assert.equal((await queryOne<any>("SELECT balance FROM users WHERE id=7"))!.balance, 1000000);
    assert.equal(os.servers.size + os.ports.size, 0);
  });

  t("seed: پلن‌های hostvds فعال با قیمت پیش‌فرض، ۳ OS اوبونتو، لوکیشن‌ها با نگاشت؛ idempotent و بدون بازنویسی قیمت ادمین", async () => {
    const { seedCatalog } = await import("../src/datacenters/cgi/seed");
    await query("TRUNCATE services RESTART IDENTITY CASCADE"); // سرویس‌های تست قبلی به پلن‌ها ارجاع دارند
    await query("DELETE FROM plans WHERE datacenter='cgi'");
    await query("DELETE FROM os_templates WHERE datacenter='cgi'");
    await query("DELETE FROM locations WHERE datacenter='cgi'");
    await query("INSERT INTO os_templates (key,name,osid,datacenter,dc_ref,active) VALUES ('cg_debian_12','Debian 12',0,'cgi','x',TRUE)"); // قدیمی؛ باید غیرفعال شود
    const a = await seedCatalog({ paris: "r2", fi: "r1" });
    const plans = await query<any>("SELECT name, hourly_price, monthly_price, active, dc_ref FROM plans WHERE datacenter='cgi' ORDER BY ram_mb");
    const byName = Object.fromEntries(plans.map((p) => [p.name, p]));
    assert.equal(a.plans.created, 3); // hostvds-1، hostvds-2، highload-1 (فلور بدون دیسک نادیده)
    assert.deepEqual([byName["hostvds-1"].hourly_price, byName["hostvds-1"].monthly_price, byName["hostvds-1"].active], [1386, 997920, true]);
    assert.deepEqual([byName["hostvds-2"].hourly_price, byName["hostvds-2"].monthly_price], [2400, 1728000]);
    assert.equal(byName["highload-1"].active, false); // قیمت پیش‌فرض ندارد ← غیرفعال
    assert.equal(byName["hostvds-1"].dc_ref, "hostvds-1"); // نام، نه UUID
    const oses = await query<any>("SELECT key, name, dc_ref, active FROM os_templates WHERE datacenter='cgi' ORDER BY key");
    assert.deepEqual(oses.filter((o) => o.active).map((o) => [o.key, o.name, o.dc_ref]), [
      ["cg_ubuntu_2004", "UBUNTU 20", "Ubuntu-20.04-amd64"], ["cg_ubuntu_2204", "UBUNTU 22", "Ubuntu-22.04-amd64"], ["cg_ubuntu_2404", "UBUNTU 24", "Ubuntu-24.04-amd64"],
    ]);
    assert.equal(oses.find((o) => o.key === "cg_debian_12").active, false);
    const locs = await query<any>("SELECT key, title, dc_ref, active FROM locations WHERE datacenter='cgi' ORDER BY key");
    assert.deepEqual(locs.filter((l) => l.active).map((l) => [l.key, l.dc_ref]), [["cgi_fi", "r1"], ["cgi_paris", "r2"]]);
    assert.equal(locs.find((l) => l.key === "cgi_lv").active, false); // نگاشت ندارد ← غیرفعال
    // ادمین قیمت را عوض می‌کند؛ seed دوباره چیزی را بازنویسی نمی‌کند
    await query("UPDATE plans SET hourly_price=999 WHERE name='hostvds-1'");
    const b = await seedCatalog({ paris: "r2", fi: "r1" });
    assert.equal(b.plans.created, 0);
    assert.equal((await queryOne<any>("SELECT hourly_price FROM plans WHERE name='hostvds-1'"))!.hourly_price, 999);
    // نگاشت لاتویا بعداً اضافه می‌شود ← فعال می‌شود
    await seedCatalog({ lv: "r2" });
    assert.equal((await queryOne<any>("SELECT active FROM locations WHERE key='cgi_lv'"))!.active, true);
    // برای بقیه‌ی تست‌ها
    await query("DELETE FROM plans WHERE datacenter='cgi'");
    await query("DELETE FROM os_templates WHERE datacenter='cgi'");
    await query("DELETE FROM locations WHERE datacenter='cgi'");
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

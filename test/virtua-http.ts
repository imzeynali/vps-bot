/**
 * تست لایه‌ی HTTP دیتاسنتر Virtua روی یک شبیه‌ساز کوچک (نمونه‌های README مستندات؛ بدون دیتابیس):
 * هدر احراز هویت، form-urlencoded، تکرار GET روی 502، success:false، تجزیه‌ی offer/system/IP/پسورد، سهمیه و حذف.
 * اجرا: npm run test:virtua
 */
import assert from "node:assert/strict";
import http from "node:http";

async function main() {
  const calls: Array<{ method: string; path: string; auth?: string; ctype?: string; body: string }> = [];
  let flaky = 1;
  const server = {
    uuid: "srv-1", name: "vs4023.par01fr.vsys.cloud", hostname: "vt7.example.com", status: "running", is_error: "0", is_setup: "1", is_suspended: "0",
    network: { ipv4: [{ address: "203.0.113.9" }, { address: "10.0.0.5" }] }, root_password: "Secr3tPass",
  };
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      calls.push({ method: req.method!, path: req.url!, auth: req.headers.authorization, ctype: req.headers["content-type"] as string | undefined, body });
      const send = (code: number, o: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.headers.authorization !== "Basic KEY123") return send(401, { success: false });
      const p = req.url!;
      if (p === "/account") return send(200, { balance: "93.6425", currency: "EUR", cloud_servers_limit: "8" });
      if (p === "/cloud/limits") {
        if (flaky-- > 0) return send(502, {});
        return send(200, { success: true, usage: { cloud_servers: 5 }, limits: { cloud_servers: "8" } });
      }
      if (p === "/project") return send(200, { success: true, projects: [{ uuid: "proj-1", name: "Default" }] });
      if (p === "/cloud/offers") return send(200, { success: true, offers: [
        { uuid: "vcs-1-ryzen", category: "vcs", name: "vCS-1", price_hour: "0.0050", vcpus: "1", memory_size: "1024", root_space: "20" },
        { uuid: "vcs-2-win-ryzen", category: "vcs-win", name: "vCS-2-WIN", price_hour: "0.0164" },
      ] });
      if (p === "/cloud/systems") return send(200, { success: true, systems: [{ uuid: "ubuntu-2204-fr", name: "Ubuntu 22.04 LTS (64 bits)" }, { uuid: "win2k19", name: "Windows Server 2019" }] });
      if (p === "/cloud/order" && req.method === "POST") {
        const f = new URLSearchParams(body);
        if (!f.get("offer") || !f.get("system") || !f.get("project")) return send(200, { success: false, messages: [{ type: "error", content: "Missing parameter" }] });
        if (f.get("offer") === "poor") return send(200, { success: false, messages: [{ type: "error", content: "Insufficient balance" }] });
        return send(200, { success: true, uuid: "srv-1" });
      }
      if (p === "/cloud-server") return send(200, { success: true, cloud_servers: [server] });
      if (p === "/cloud-server/srv-1" && req.method === "GET") return send(200, { success: true, ...server });
      if (p === "/cloud-server/srv-1" && req.method === "DELETE") return send(200, { success: true, uuid: "srv-1", messages: [{ type: "notice", content: "Server destroyed." }] });
      if (p === "/cloud-server/srv-1/restart") return send(200, { success: true, messages: [{ type: "notice", content: "Restart in progress..." }] });
      return send(404, { success: false, messages: [{ type: "error", content: "not found" }] });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  Object.assign(process.env, {
    VIRTUA_API_URL: `http://127.0.0.1:${port}`, VIRTUA_API_KEY: "KEY123", VIRTUA_TIMEOUT_MS: "3000", VIRTUA_POLL_MS: "50",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgres://x:y@127.0.0.1:1/z", BOT_TOKEN: process.env.BOT_TOKEN ?? "1:x", ADMIN_IDS: "1",
  });
  const H = await import("../src/datacenters/virtua/http");
  const S = await import("../src/datacenters/virtua/seed");
  const { config } = await import("../src/core");

  const tests: [string, () => Promise<void>][] = [];
  const t = (n: string, f: () => Promise<void>) => tests.push([n, f]);

  t("هدر «Authorization: Basic <کلید خام>» و GET روی 502 گذرا دوباره تلاش می‌شود", async () => {
    const l = await H.limits();
    assert.deepEqual(l.servers, [5, 8]);
    assert.equal(l.balance, "93.6425");
    assert.equal(calls.filter((c) => c.path === "/cloud/limits").length, 2);
    assert.ok(calls.every((c) => c.auth === "Basic KEY123"));
  });
  t("سفارش به‌صورت form-urlencoded با نام پارامترهای مثال مستندات", async () => {
    const r = await H.call<{ uuid: string }>("POST", "/cloud/order", { offer: "vcs-1-ryzen", system: "ubuntu-2204-fr", project: "proj-1", ipv6_enable: "0", hostname: "vt7.example.com" });
    assert.equal(r.uuid, "srv-1");
    const c = calls.find((x) => x.path === "/cloud/order")!;
    assert.equal(c.ctype, "application/x-www-form-urlencoded");
    assert.equal(new URLSearchParams(c.body).get("ipv6_enable"), "0");
  });
  t("success:false با HTTP 200 ← خطای http با متن پیام و راهنمای کاربر", async () => {
    await assert.rejects(() => H.call("POST", "/cloud/order", { offer: "poor", system: "s", project: "p" }), (e: any) => e.kind === "http" && /Insufficient balance/.test(e.message) && !!e.userHint);
  });
  t("کلید اشتباه ← خطای auth", async () => {
    const mutable = config.virtua as { apiKey: string };
    mutable.apiKey = "BAD";
    await assert.rejects(() => H.call("GET", "/account"), (e: any) => e.kind === "auth" && e.status === 401);
    mutable.apiKey = "KEY123";
  });
  t("تجزیه‌ی offerها: ویندوز حذف و مشخصات خوانده می‌شود", async () => {
    const offers = S.parseOffers(await H.call("GET", "/cloud/offers"));
    assert.equal(offers.length, 1);
    assert.deepEqual([offers[0]!.uuid, offers[0]!.vcpus, offers[0]!.ramMb, offers[0]!.diskGb], ["vcs-1-ryzen", 1, 1024, 20]);
  });
  t("IP عمومی از جزئیات سرور (IP خصوصی نادیده) و پسورد با فیلد تنظیم‌شده", async () => {
    const s = await H.getServer("srv-1");
    assert.equal(H.ipv4Of(s!.raw), "203.0.113.9");
    assert.equal(H.passwordOf(s!.raw), "Secr3tPass"); // کلید root_password
    assert.equal(H.passwordOf({ a: { pw: "xyz123456" } }, "a.pw"), "xyz123456");
    assert.equal(H.passwordOf({ foo: "bar" }), null);
  });
  t("وضعیت سرور و لیست سرورها با hostname", async () => {
    const s = await H.getServer("srv-1");
    assert.deepEqual([s!.status, s!.isSetup, s!.isError], ["running", true, false]);
    assert.equal((await H.listServers()).find((x) => x.hostname === "vt7.example.com")?.uuid, "srv-1");
    assert.equal(await H.getServer("nope"), null);
  });
  t("پروژه: اولین پروژه‌ی حساب یا VIRTUA_PROJECT", async () => {
    assert.equal(await H.projectUuid(), "proj-1");
    (config.virtua as { project: string }).project = "mine";
    assert.equal(await H.projectUuid(), "mine");
    (config.virtua as { project: string }).project = "";
  });
  t("ریبوت و حذف", async () => {
    await H.call("POST", "/cloud-server/srv-1/restart");
    const d = await H.call<{ success: boolean }>("DELETE", "/cloud-server/srv-1");
    assert.equal(d.success, true);
  });
  t("تجزیه‌ی قیمت‌ها", async () => {
    assert.deepEqual(S.parsePrices("vCS-1=2500,vCS-2=0,x=y,vCS-4=9000"), { "vCS-1": 2500, "vCS-4": 9000 });
  });

  let failed = 0;
  for (const [name, f] of tests) {
    try { await f(); console.log("✅", name); } catch (e) { failed++; console.log("❌", name, "\n   ", e instanceof Error ? e.message : e); }
  }
  srv.closeAllConnections?.(); srv.close();
  console.log(failed ? `\n${failed} تست ناموفق` : `\nهمه‌ی ${tests.length} تست Virtua (HTTP) سبز است`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

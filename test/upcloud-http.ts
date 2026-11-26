/**
 * تست لایه‌ی HTTP دیتاسنتر UpCloud روی یک شبیه‌ساز کوچک (نمونه‌های مستندات API 1.3؛ بدون دیتابیس):
 * هدر Bearer، ساختار بدنه‌ی ساخت (clone/tier/public IPv4/user_data)، حالت api (login_user)، تجزیه‌ی پلن/زون/تمپلیت/IP،
 * stop سخت قبل از حذف، error پاکت UpCloud، تکرار GET روی 502.
 * اجرا: npm run test:upcloud
 */
import assert from "node:assert/strict";
import http from "node:http";

async function main() {
  const calls: Array<{ method: string; path: string; auth?: string; body: any }> = [];
  let flaky = 1;
  let state = "stopped";
  const send = (res: http.ServerResponse, code: number, o?: unknown) => { res.writeHead(code, { "Content-Type": "application/json" }); res.end(o === undefined ? "" : JSON.stringify(o)); };
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      let body: any = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { /* */ }
      calls.push({ method: req.method!, path: u.pathname + u.search, auth: req.headers.authorization, body });
      if (req.headers.authorization !== "Bearer ucat_TEST") return send(res, 401, { error: { error_code: "AUTHENTICATION_FAILED", error_message: "Authentication failed using the given username and password." } });
      const p = u.pathname.replace(/^\/1\.3/, "");
      if (p === "/account") return send(res, 200, { account: { credits: 10000, username: "me", resource_limits: { cores: 100 } } });
      if (p === "/zone") return send(res, 200, { zones: { zone: [{ id: "fi-hel1", description: "Helsinki #1", public: "yes" }, { id: "de-fra1", description: "Frankfurt #1", public: "yes" }, { id: "x-priv", description: "Private", public: "no" }] } });
      if (p === "/plan") {
        if (flaky-- > 0) return send(res, 502, {});
        return send(res, 200, { plans: { plan: [
          { name: "1xCPU-1GB", core_number: 1, memory_amount: 1024, storage_size: 25, storage_tier: "maxiops", public_traffic_out: 1024 },
          { name: "GPU-12xCPU-128GB-1xL40S", core_number: 12, memory_amount: 131072, storage_size: 100, storage_tier: "maxiops" },
          { name: "custom", core_number: 0, memory_amount: 0, storage_size: 0 },
        ] } });
      }
      if (p === "/storage/template") return send(res, 200, { storages: { storage: [{ uuid: "tpl-2204", title: "Ubuntu Server 22.04 LTS (Jammy Jellyfish)", type: "template" }, { uuid: "tpl-win", title: "Windows Server 2022" }] } });
      if (p === "/server" && req.method === "POST") {
        if (body.server?.plan === "bad") return send(res, 400, { error: { error_code: "PLAN_NOT_FOUND", error_message: "The plan was not found" } });
        state = "maintenance";
        return send(res, 202, { server: { uuid: "srv-1", state: "maintenance", zone: body.server.zone, ...(body.server.login_user ? { password: "GenPass123" } : {}) } });
      }
      if (p === "/server" && req.method === "GET") return send(res, 200, { servers: { server: [{ uuid: "srv-1", hostname: "up7.example.com", state, zone: "fi-hel1", title: "bot-7" }] } });
      if (p === "/server/srv-1" && req.method === "GET") { if (state === "maintenance") state = "started"; return send(res, 200, { server: { uuid: "srv-1", hostname: "up7.example.com", state, zone: "fi-hel1" } }); }
      if (p === "/server/srv-1/networking") return send(res, 200, { networking: { interfaces: { interface: [
        { index: 1, type: "public", ip_addresses: { ip_address: [{ address: "203.0.113.20", family: "IPv4" }] } },
        { index: 2, type: "utility", ip_addresses: { ip_address: [{ address: "10.1.2.3", family: "IPv4" }] } },
      ] } } });
      if (p === "/server/srv-1/stop") { state = "stopped"; return send(res, 200, { server: { uuid: "srv-1", state: "maintenance" } }); }
      if (p === "/server/srv-1" && req.method === "DELETE") {
        if (state !== "stopped") return send(res, 409, { error: { error_code: "SERVER_STATE_ILLEGAL", error_message: "Server is not in a valid state for this operation" } });
        return send(res, 204);
      }
      return send(res, 404, { error: { error_code: "NOT_FOUND", error_message: "not found" } });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  Object.assign(process.env, {
    UPCLOUD_API_URL: `http://127.0.0.1:${port}/1.3`, UPCLOUD_TOKEN: "ucat_TEST", UPCLOUD_TIMEOUT_MS: "3000", UPCLOUD_POLL_MS: "50", UPCLOUD_TIER: "maxiops",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgres://x:y@127.0.0.1:1/z", BOT_TOKEN: process.env.BOT_TOKEN ?? "1:x", ADMIN_IDS: "1",
  });
  const H = await import("../src/datacenters/upcloud/http");
  const S = await import("../src/datacenters/upcloud/seed");
  const D = await import("../src/datacenters/upcloud");
  const { config } = await import("../src/core");

  const tests: [string, () => Promise<void>][] = [];
  const t = (n: string, f: () => Promise<void>) => tests.push([n, f]);

  t("هدر «Authorization: Bearer ucat_…» و اعتبار حساب", async () => {
    const a = await H.account();
    assert.deepEqual([a.username, a.credits], ["me", 10000]);
    assert.equal(calls[0]!.auth, "Bearer ucat_TEST");
  });
  t("توکن اشتباه ← خطای auth با پیام UpCloud", async () => {
    const m = config.upcloud as { token: string };
    m.token = "ucat_BAD";
    await assert.rejects(() => H.account(), (e: any) => e.kind === "auth" && e.status === 401 && /Authentication failed/.test(e.message));
    m.token = "ucat_TEST";
  });
  t("تجزیه‌ی پلن‌ها (GPU و custom حذف؛ اعداد رشته‌ای) و GET روی 502 گذرا تکرار می‌شود", async () => {
    const plans = S.parsePlans(await H.call("GET", "/plan"));
    assert.deepEqual(plans, [{ name: "1xCPU-1GB", cores: 1, ramMb: 1024, diskGb: 25, tier: "maxiops" }]);
    assert.equal(calls.filter((c) => c.path === "/1.3/plan").length, 2);
  });
  t("زون‌های عمومی و تمپلیت‌ها", async () => {
    assert.deepEqual(S.parseZones(await H.call("GET", "/zone")).map((z) => z.id), ["fi-hel1", "de-fra1"]);
    const tpl = H.listIn(await H.call("GET", "/storage/template"), "storages", "storage");
    assert.equal(tpl.find((x) => /ubuntu server 22\.04/i.test(x.title))?.uuid, "tpl-2204");
  });
  t("بدنه‌ی ساخت (userdata): clone دیسک هم‌اندازه‌ی پلن با tier، فقط public IPv4، metadata + user_data", async () => {
    const b = D.serverBody({ zone: "fi-hel1", title: "bot-7", hostname: "up7.example.com", plan: "1xCPU-1GB", template: "tpl-2204", sizeGb: 25, password: "AbC123xyz" }).server as any;
    assert.equal(b.metadata, "yes");
    assert.match(b.user_data, /#cloud-config[\s\S]*root:AbC123xyz/);
    assert.equal(b.login_user, undefined);
    assert.deepEqual(b.storage_devices.storage_device[0], { action: "clone", storage: "tpl-2204", title: "up7.example.com-disk0", size: 25, tier: "maxiops" });
    assert.deepEqual(b.networking.interfaces.interface, [{ type: "public", ip_addresses: { ip_address: [{ family: "IPv4" }] } }]);
  });
  t("بدنه‌ی ساخت (api): login_user با create_password و بدون user_data", async () => {
    (config.upcloud as { passwordMode: string }).passwordMode = "api";
    const b = D.serverBody({ zone: "z", title: "t", hostname: "h", plan: "p", template: "tp", sizeGb: 25, password: "x" }) as any;
    assert.deepEqual(b.server.login_user, { username: "root", create_password: "yes" });
    assert.equal(b.server.password_delivery, "none");
    assert.equal(b.server.user_data, undefined);
    const r = await H.call("POST", "/server", b);
    assert.equal(H.passwordOf(r), "GenPass123");
    (config.upcloud as { passwordMode: string }).passwordMode = "userdata";
  });
  t("خطای پاکت UpCloud (error_code) و راهنمای کاربر", async () => {
    await assert.rejects(() => H.call("POST", "/server", { server: { plan: "bad" } }), (e: any) => e.kind === "http" && e.code === "PLAN_NOT_FOUND" && /plan was not found/.test(e.message) && !!e.userHint);
  });
  t("ساخت ← state=maintenance سپس started؛ IP عمومی از networking (utility/خصوصی نادیده)", async () => {
    const s = await H.waitState("srv-1", "started", 3000);
    assert.equal(s.state, "started");
    assert.equal(await H.networkingIp("srv-1"), "203.0.113.20");
  });
  t("حذف سرور روشن 409 می‌دهد؛ بعد از stop سخت و توقف، DELETE با storages=1 موفق است", async () => {
    await assert.rejects(() => H.call("DELETE", "/server/srv-1", undefined, { storages: "1" }), (e: any) => e.status === 409 && e.code === "SERVER_STATE_ILLEGAL");
    await H.call("POST", "/server/srv-1/stop", { stop_server: { stop_type: "hard" } });
    await H.waitState("srv-1", "stopped", 3000);
    await H.call("DELETE", "/server/srv-1", undefined, { storages: "1" });
    const del = calls.filter((c) => c.method === "DELETE").pop()!;
    assert.match(del.path, /storages=1/);
  });
  t("لیست سرورها با hostname و جستجو", async () => {
    const l = await H.listServers("up7.example.com");
    assert.equal(l.find((x) => x.hostname === "up7.example.com")?.uuid, "srv-1");
    assert.match(calls.filter((c) => c.path.startsWith("/1.3/server?")).pop()!.path, /search=up7\.example\.com/);
  });
  t("تجزیه‌ی قیمت‌ها", async () => {
    assert.deepEqual(S.parsePrices("1xCPU-1GB=2500,x=0,2xCPU-4GB=9000"), { "1xCPU-1GB": 2500, "2xCPU-4GB": 9000 });
  });

  let failed = 0;
  for (const [name, f] of tests) {
    try { await f(); console.log("✅", name); } catch (e) { failed++; console.log("❌", name, "\n   ", e instanceof Error ? e.message : e); }
  }
  srv.closeAllConnections?.(); srv.close();
  console.log(failed ? `\n${failed} تست ناموفق` : `\nهمه‌ی ${tests.length} تست UpCloud (HTTP) سبز است`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

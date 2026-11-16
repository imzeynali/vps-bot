/**
 * تست لایه‌ی HTTP/OpenStack دیتاسنتر 3HCloud روی یک شبیه‌ساز کوچک (بدون دیتابیس):
 * احراز هویت با نام‌کاربری/رمز، کاتالوگ، ساخت از روی volume، فیلتر شبکه‌ی عمومی، retry روی 502، تجزیه‌ی نگاشت‌ها.
 * اجرا: npm run test:h3chttp
 */
import assert from "node:assert/strict";
import http from "node:http";

async function main() {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  let flaky502 = 1; // اولین GET /limits یک‌بار 502 می‌دهد
  let port = 0;
  const srv = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const u = new URL(req.url!, "http://x");
      let body: any = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}; } catch { /* */ }
      const send = (code: number, o: unknown = {}, h: Record<string, string> = {}) => { res.writeHead(code, { "Content-Type": "application/json", ...h }); res.end(JSON.stringify(o)); };
      const base = `http://127.0.0.1:${port}`;
      if (u.pathname === "/v3/auth/tokens") {
        const pw = body?.auth?.identity?.password?.user;
        const scope = body?.auth?.scope?.project;
        calls.push({ method: "AUTH", path: u.pathname, body: { user: pw?.name, domain: pw?.domain?.name, scope } });
        if (body?.auth?.identity?.methods?.[0] !== "password" || pw?.name !== "api1" || pw?.password !== "PW" || !scope) return send(401, { error: { message: "bad" } });
        const ep = (type: string, p: string) => ({ type, endpoints: ["MIA"].map((r) => ({ interface: "public", region: r, region_id: r, url: `${base}/${r}${p}` })) });
        return send(201, { token: { expires_at: new Date(Date.now() + 3600_000).toISOString(), catalog: [ep("compute", "/nova"), ep("network", "/neutron"), ep("image", "/glance"), ep("volumev3", "/cinder/PROJ")] } }, { "x-subject-token": "TOK" });
      }
      if (req.headers["x-auth-token"] !== "TOK") return send(401, {});
      calls.push({ method: req.method!, path: u.pathname + u.search, body });
      const p = u.pathname.replace(/^\/MIA/, "");
      if (p === "/nova/limits") {
        if (flaky502-- > 0) return send(502, {});
        return send(200, { limits: { absolute: { totalInstancesUsed: 1, maxTotalInstances: 10, totalCoresUsed: 1, maxTotalCores: 20, totalRAMUsed: 1024, maxTotalRAMSize: 51200 } } });
      }
      if (p === "/nova/servers" && req.method === "POST") return send(202, { server: { id: "srv-1" } });
      if (p === "/neutron/v2.0/networks") return send(200, { networks: [{ id: "n-ext", name: "ext-net", "router:external": true }, { id: "n-int", name: "private-1", "router:external": false }] });
      if (p === "/neutron/v2.0/subnets") return send(200, { subnets: [{ id: "s1", network_id: "n-ext", ip_version: 4, cidr: "203.0.113.0/24" }, { id: "s2", network_id: "n-int", ip_version: 4, cidr: "10.0.0.0/24" }] });
      if (p === "/neutron/v2.0/security-groups") return send(200, { security_groups: [{ id: "sg-1", name: "allow_all" }] });
      if (p === "/neutron/v2.0/ports" && req.method === "POST") {
        if (body.port.network_id !== "n-ext") return send(400, { NeutronError: { message: "internal network chosen!", type: "Bad" } });
        return send(201, { port: { id: "port-1", network_id: "n-ext", fixed_ips: [{ ip_address: "203.0.113.7", subnet_id: "s1" }] } });
      }
      if (p === "/cinder/PROJ/types") return send(200, { volume_types: [{ name: "ultra-ssd" }] });
      return send(404, { itemNotFound: { message: "unknown " + p } });
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  port = (srv.address() as any).port;
  Object.assign(process.env, {
    H3C_AUTH_URLS: `MIA=http://127.0.0.1:${port}`, H3C_AUTH_URL: "https://identity.api.os.{code}.3hcloud.com", H3C_USERNAME: "api1", H3C_PASSWORD: "PW", H3C_USER_DOMAIN: "Default",
    H3C_PROJECT: "myproj", H3C_PROJECT_DOMAIN: "Default", H3C_REGION: "MIA", H3C_TIMEOUT_MS: "3000", H3C_POLL_MS: "50",
    DATABASE_URL: process.env.DATABASE_URL ?? "postgres://x:y@127.0.0.1:1/z", BOT_TOKEN: process.env.BOT_TOKEN ?? "1:x", ADMIN_IDS: "1",
  });
  const H = await import("../src/datacenters/h3c/http");
  const OS = await import("../src/datacenters/h3c/openstack");
  const SEED = await import("../src/datacenters/h3c/seed");
  const { config } = await import("../src/core");

  const tests: [string, () => Promise<void>][] = [];
  const t = (n: string, f: () => Promise<void>) => tests.push([n, f]);

  t("احراز هویت با نام‌کاربری/رمز و scope پروژه (نام + دامنه)", async () => {
    await OS.volumeTypes("MIA"); // اولین فراخوانی احراز هویت می‌کند
    const a = calls.find((c) => c.method === "AUTH")!;
    assert.equal(a.body.user, "api1");
    assert.deepEqual(a.body.scope, { name: "myproj", domain: { name: "Default" } });
  });
  t("GET روی 502 گذرا دوباره تلاش می‌شود", async () => {
    const l = await OS.limits("MIA");
    assert.deepEqual(l.instances, [1, 10]);
    assert.equal(calls.filter((c) => c.path.endsWith("/nova/limits")).length, 2);
  });
  t("ساخت از روی volume وقتی فلور دیسک ندارد (BDM + نوع دیسک + AZ)", async () => {
    const b = OS.serverBody({ name: "h3c-1", flavorRef: "F", imageRef: "IMG", portId: "P", userDataB64: "x", bootVolume: { sizeGb: 40, volumeType: "ultra-ssd" }, az: "MIA-1" }).server as any;
    assert.equal(b.imageRef, undefined);
    assert.equal(b.availability_zone, "MIA-1");
    assert.deepEqual(b.block_device_mapping_v2[0], { boot_index: 0, uuid: "IMG", source_type: "image", destination_type: "volume", volume_size: 40, delete_on_termination: true, volume_type: "ultra-ssd" });
    assert.deepEqual(b.networks, [{ port: "P" }]);
  });
  t("ساخت با دیسک خودِ فلور: imageRef مستقیم و بدون BDM", async () => {
    const b = OS.serverBody({ name: "h3c-2", flavorRef: "F", imageRef: "IMG", portId: "P", userDataB64: "x" }).server as any;
    assert.equal(b.imageRef, "IMG");
    assert.equal(b.block_device_mapping_v2, undefined);
    assert.equal(await OS.createServer("MIA", { name: "n", flavorRef: "F", imageRef: "I", portId: "P", userDataB64: "x" }), "srv-1");
  });
  t("فقط شبکه‌ی external انتخاب می‌شود؛ پورت روی شبکه‌ی داخلی ساخته نمی‌شود", async () => {
    const nets = await OS.publicNetworks("MIA");
    assert.deepEqual(nets.map((n) => n.name), ["ext-net"]);
    const sg = await OS.securityGroupId("MIA", "allow_all");
    const port = await OS.createPortAnywhere("MIA", "h3c-1", sg);
    assert.equal(OS.ipv4OfPort(port), "203.0.113.7");
  });
  t("H3C_NETWORK نام شبکه را مشخص می‌کند و نبودنش خطای config با راهنما می‌دهد", async () => {
    const mutable = config.h3c as { network: string };
    mutable.network = "private-1";
    assert.deepEqual((await OS.publicNetworks("MIA")).map((n) => n.name), ["private-1"]);
    mutable.network = "nope";
    await assert.rejects(() => OS.publicNetworks("MIA"), (e: any) => e.kind === "config" && /H3C_NETWORK/.test(e.message));
    mutable.network = "";
  });
  t("انواع دیسک Cinder از سرویس volumev3 خوانده می‌شود", async () => {
    assert.deepEqual(await OS.volumeTypes("MIA"), ["ultra-ssd"]);
  });
  t("رمز اشتباه ← خطای auth", async () => {
    H.resetSession();
    (config.h3c as { password: string }).password = "BAD";
    await assert.rejects(() => OS.limits("MIA"), (e: any) => e.kind === "auth" && e.status === 401);
    (config.h3c as { password: string }).password = "PW";
    H.resetSession();
  });
  t("هر ریجن Keystone جدا دارد: الگو با {code}، جایگزینی دستی و پسوند /v3", async () => {
    assert.equal(H.authUrlFor("Dallas"), "https://identity.api.os.dfw.3hcloud.com/v3");
    assert.equal(H.authUrlFor("SanFrancisco"), "https://identity.api.os.sfo.3hcloud.com/v3");
    assert.equal(H.authUrlFor("Almaty"), "https://identity.api.os.ala.3hcloud.com/v3");
    assert.equal(H.authUrlFor("MIA"), `http://127.0.0.1:${port}/v3`);
    assert.deepEqual(H.KNOWN_REGIONS, ["Miami", "Dallas", "SanFrancisco", "Warsaw", "Almaty", "Manila"]);
  });
  t("splitRef و تجزیه‌ی نگاشت ریجن/قیمت", async () => {
    assert.deepEqual(H.splitRef("Reg1/MIA-1"), { region: "Reg1", az: "MIA-1" });
    assert.deepEqual(H.splitRef("Reg1"), { region: "Reg1", az: null });
    assert.deepEqual(SEED.parseRegionMap("mia=Reg1/MIA-1, waw=Reg2,bad=x y"), { mia: "Reg1/MIA-1", waw: "Reg2" });
    assert.deepEqual(SEED.parsePrices("a-b=2500,c=0,d=x,e=1000"), { "a-b": 2500, e: 1000 });
  });

  let failed = 0;
  for (const [name, f] of tests) {
    try { await f(); console.log("✅", name); } catch (e) { failed++; console.log("❌", name, "\n   ", e instanceof Error ? e.message : e); }
  }
  srv.closeAllConnections?.(); srv.close();
  console.log(failed ? `\n${failed} تست ناموفق` : `\nهمه‌ی ${tests.length} تست 3HCloud (HTTP) سبز است`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });

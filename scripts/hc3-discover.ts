export {};
/**
 * کشف اطلاعات 3HCloud (OpenStack) — فقط‌خواندنی؛ هیچ چیزی نمی‌سازد/حذف نمی‌کند.
 * هر ریجن Keystone جداگانه دارد؛ کاربر API و پروژه مشترک است. ریجن‌ها: src/datacenters/hcloud3/regions.ts
 * متغیرها در .env.local:
 *   HC3_USERNAME=api-xxxx   (OS_USERNAME)
 *   HC3_PASSWORD=...        (پسوردی که هنگام ساخت کاربر API نشان داده شد؛ در RC نیست)
 *   HC3_PROJECT_ID=...      (OS_PROJECT_ID؛ یا HC3_PROJECT_NAME)
 *   HC3_USER_DOMAIN=Default  HC3_PROJECT_DOMAIN=default
 *   HC3_ONLY=dallas,warsaw  (اختیاری؛ فقط این ریجن‌ها)
 * اجرا: npm run hc3:discover
 */
type J = Record<string, any>;
const E = process.env;

async function http(method: string, url: string, token: string, body?: unknown) {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { "X-Auth-Token": token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let json: J = {};
  try { json = JSON.parse(text); } catch { /* غیر JSON */ }
  return { status: r.status, json, headers: r.headers };
}
const section = (t: string) => console.log(`\n── ${t} ──`);
const safe = async (title: string, f: () => Promise<void>) => {
  section(title);
  try { await f(); } catch (e) { console.log("⚠️ خطا:", e instanceof Error ? e.message : e); }
};

interface Summary { region: string; auth: string; flavors?: number; images?: number; volumeTypes?: number; networks?: number; quota?: string; zones?: string }

async function discoverRegion(r: { key: string; name: string; authUrl: string; title: string }, ks: (u: string) => string): Promise<Summary> {
  const sum: Summary = { region: `${r.title} (${r.name})`, auth: "؟" };
  console.log(`\n\n████████ ${r.title} — ${r.name} ████████\nKeystone: ${r.authUrl}`);

  section("احراز هویت");
  const scope = E.HC3_PROJECT_ID ? { project: { id: E.HC3_PROJECT_ID } } : { project: { name: E.HC3_PROJECT_NAME, domain: { id: E.HC3_PROJECT_DOMAIN ?? "default" } } };
  let a;
  try {
    a = await http("POST", `${ks(r.authUrl)}/auth/tokens`, "", {
      auth: { identity: { methods: ["password"], password: { user: { name: E.HC3_USERNAME, domain: { name: E.HC3_USER_DOMAIN ?? "Default" }, password: E.HC3_PASSWORD } } }, scope },
    });
  } catch (e) {
    console.log("❌ اتصال برقرار نشد:", e instanceof Error ? e.message : e);
    sum.auth = "❌ اتصال";
    return sum;
  }
  console.log("HTTP", a.status);
  if (a.status !== 201) {
    console.log("❌ ورود ناموفق:", JSON.stringify(a.json).slice(0, 250));
    console.log("راهنما: 401 = یوزرنیم/پسورد (ممکن است پسورد این ریجن فرق داشته باشد)؛ 400/404 = دامنه/پروژه یا آدرس Keystone.");
    sum.auth = `❌ HTTP ${a.status}`;
    return sum;
  }
  sum.auth = "✅";
  const token = a.headers.get("x-subject-token") ?? "";
  const tok = a.json.token as J;
  console.log("✅ انقضا:", tok.expires_at, "| پروژه:", tok.project?.name, "| نقش‌ها:", (tok.roles ?? []).map((x: J) => x.name).join(","));

  const catalog = (tok.catalog ?? []) as J[];
  const publicEps = (type: string) => ((catalog.find((c) => c.type === type)?.endpoints ?? []) as J[]).filter((e) => e.interface === "public");
  const ep = (...types: string[]) => {
    for (const t of types) {
      const list = publicEps(t);
      const hit = list.find((e) => e.region === r.name || e.region_id === r.name) ?? list[0];
      if (hit) return String(hit.url).replace(/\/+$/, "");
    }
    return undefined;
  };
  section("سرویس‌ها (public)");
  for (const c of catalog) for (const e of (c.endpoints as J[]).filter((x) => x.interface === "public")) console.log(String(c.type).padEnd(16), String(e.region).padEnd(14), e.url);
  const compute = ep("compute"), network = ep("network"), image = ep("image"), volume = ep("volumev3", "block-storage", "volumev2");
  if (!compute || !network || !image) {
    console.log("⚠️ compute/network/image در کاتالوگ نیست؛ ادامه ممکن نیست.");
    return sum;
  }
  const T = (u: string) => http("GET", u, token);

  await safe("نسخه‌ی Nova", async () => {
    const root = compute.replace(/\/[0-9a-f]{32}$/, "");
    const x = await T(root + "/");
    console.log("HTTP", x.status, JSON.stringify(x.json.version ?? x.json).slice(0, 160));
  });
  await safe("زون‌ها (AZ)", async () => {
    const x = await T(`${compute}/os-availability-zone`);
    const zs = ((x.json.availabilityZoneInfo ?? []) as J[]).map((z) => `${z.zoneName}${z.zoneState?.available ? "" : "(×)"}`);
    sum.zones = zs.join(" ");
    console.log("HTTP", x.status, sum.zones);
  });
  await safe("فلورها (دیسک ۰ یعنی بوت از volume)", async () => {
    const x = await T(`${compute}/flavors/detail`);
    const list = (x.json.flavors ?? []) as J[];
    sum.flavors = list.length;
    console.log("HTTP", x.status, `(${list.length} مورد)`);
    for (const f of list) console.log(`${f.id}  ${String(f.name).padEnd(22)} vcpu=${f.vcpus} ram=${f.ram}MB disk=${f.disk}GB public=${f["os-flavor-access:is_public"]}`);
  });
  await safe("ایمیج‌ها (OS)", async () => {
    const x = await T(`${image}/v2/images?limit=100`);
    const list = (x.json.images ?? []) as J[];
    sum.images = list.length;
    console.log("HTTP", x.status, `(${list.length} مورد)`);
    for (const i of list) console.log(`${i.id}  ${String(i.name).padEnd(34)} ${i.status} ${i.visibility} min_disk=${i.min_disk} os=${i.os_distro ?? "-"} agent=${i.hw_qemu_guest_agent ?? "-"}`);
  });
  await safe("نوع volume ها (Cinder) و سهمیه‌ی دیسک", async () => {
    if (!volume) return console.log("→ سرویس Cinder در کاتالوگ نیست.");
    const t = await T(`${volume}/types`);
    const list = (t.json.volume_types ?? []) as J[];
    sum.volumeTypes = list.length;
    console.log("HTTP", t.status);
    for (const v of list) console.log(`${v.id}  ${v.name}  public=${v.is_public}  ${v.description ?? ""}`);
    const l = await T(`${volume}/limits`);
    const q = (l.json.limits?.absolute ?? {}) as J;
    console.log(`volume: ${q.totalVolumesUsed}/${q.maxTotalVolumes}  حجم(GB): ${q.totalGigabytesUsed}/${q.maxTotalVolumeGigabytes}`);
  });
  await safe("شبکه‌ها", async () => {
    const [n, s] = await Promise.all([T(`${network}/v2.0/networks`), T(`${network}/v2.0/subnets`)]);
    console.log("HTTP", n.status, s.status);
    const subs = (s.json.subnets ?? []) as J[];
    const list = (n.json.networks ?? []) as J[];
    sum.networks = list.length;
    for (const x of list) {
      const cidrs = subs.filter((q) => q.network_id === x.id).map((q) => `v${q.ip_version}:${q.cidr}`).join(" ");
      console.log(`${x.id}  ${String(x.name).padEnd(22)} shared=${x.shared} ext=${x["router:external"]} az=${(x.availability_zone_hints ?? []).join(",") || "-"} ${cidrs}`);
    }
  });
  await safe("پورت‌ها و Floating IP موجود (آی‌پی بی‌صاحب هزینه دارد)", async () => {
    const [p, f] = await Promise.all([T(`${network}/v2.0/ports`), T(`${network}/v2.0/floatingips`)]);
    console.log(`ports=${(p.json.ports ?? []).length} (HTTP ${p.status})  floating_ips=${(f.json.floatingips ?? []).length} (HTTP ${f.status})`);
  });
  await safe("گروه‌های امنیتی و قوانین (فایروال مجازی)", async () => {
    const x = await T(`${network}/v2.0/security-groups`);
    console.log("HTTP", x.status);
    for (const g of (x.json.security_groups ?? []) as J[]) {
      console.log(`• ${g.name} (${g.id})`);
      for (const q of (g.security_group_rules ?? []) as J[]) {
        console.log(`   ${q.direction.padEnd(7)} ${q.ethertype} ${String(q.protocol ?? "any").padEnd(5)} ${q.port_range_min ?? "*"}-${q.port_range_max ?? "*"}  ←→ ${q.remote_ip_prefix ?? q.remote_group_id ?? "any"}`);
      }
    }
  });
  await safe("QoS policy (برای محدودیت سرعت)", async () => {
    const x = await T(`${network}/v2.0/qos/policies`);
    console.log("HTTP", x.status);
    for (const q of (x.json.policies ?? []) as J[]) console.log(`${q.id}  ${q.name}  shared=${q.shared}`);
  });
  await safe("سهمیه‌ی Nova (سطح ریجن)", async () => {
    const x = await T(`${compute}/limits`);
    const l = (x.json.limits?.absolute ?? {}) as J;
    sum.quota = `سرور ${l.totalInstancesUsed}/${l.maxTotalInstances} | هسته ${l.totalCoresUsed}/${l.maxTotalCores} | RAM ${l.totalRAMUsed}/${l.maxTotalRAMSize}MB`;
    console.log(sum.quota);
  });
  return sum;
}

async function main() {
  if (!E.HC3_USERNAME || !E.HC3_PASSWORD || !(E.HC3_PROJECT_ID || E.HC3_PROJECT_NAME)) {
    console.log("❌ HC3_USERNAME / HC3_PASSWORD / HC3_PROJECT_ID (یا HC3_PROJECT_NAME) را در .env.local بگذارید.");
    process.exit(1);
  }
  const { hc3Regions, keystoneBase } = await import("../src/datacenters/hcloud3/regions");
  const only = (E.HC3_ONLY ?? "").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
  const out: Summary[] = [];
  for (const r of hc3Regions().filter((x) => !only.length || only.includes(x.key))) out.push(await discoverRegion(r, keystoneBase));

  console.log("\n\n════════ خلاصه ════════");
  for (const s of out) {
    console.log(`${s.auth} ${s.region}  AZ: ${s.zones ?? "-"}  | فلور ${s.flavors ?? "-"} | ایمیج ${s.images ?? "-"} | volume-type ${s.volumeTypes ?? "-"} | شبکه ${s.networks ?? "-"}\n     ${s.quota ?? ""}`);
  }
  console.log("\n✅ تمام. این خروجی را (بدون پسورد) بفرستید.");
}
main().catch((e) => { console.error(e); process.exit(1); });

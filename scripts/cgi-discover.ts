/**
 * کشف اطلاعات CGI (HostVDS / OpenStack) — فقط‌خواندنی؛ هیچ چیزی نمی‌سازد/حذف نمی‌کند.
 * متغیرها در .env.local:
 *   CGI_AUTH_URL=https://os-api.hostvds.com/identity/v3
 *   CGI_APP_CRED_ID=...        CGI_APP_CRED_SECRET=...
 *   CGI_REGION=eu-north3       (اختیاری)
 * اجرا: npx tsx --env-file=.env.local scripts/cgi-discover.ts
 */
export {}; // ماژول (جلوگیری از تداخل نام‌ها با اسکریپت‌های دیگر)
const AUTH = (process.env.CGI_AUTH_URL ?? "").replace(/\/+$/, "");
const ID = process.env.CGI_APP_CRED_ID ?? "";
const SECRET = process.env.CGI_APP_CRED_SECRET ?? "";
const REGION = process.env.CGI_REGION ?? "";

type J = Record<string, any>;
let TOKEN = "";

async function http(method: string, url: string, body?: unknown, extra: Record<string, string> = {}) {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json", ...(TOKEN ? { "X-Auth-Token": TOKEN } : {}), ...extra },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  let json: J = {};
  try { json = JSON.parse(text); } catch { /* غیر JSON */ }
  return { status: r.status, json, headers: r.headers, text };
}

const section = (t: string) => console.log(`\n━━━ ${t} ━━━`);
const safe = async (title: string, f: () => Promise<void>) => {
  section(title);
  try { await f(); } catch (e) { console.log("⚠️ خطا:", e instanceof Error ? e.message : e); }
};

async function main() {
  if (!AUTH || !ID || !SECRET) {
    console.log("❌ CGI_AUTH_URL / CGI_APP_CRED_ID / CGI_APP_CRED_SECRET را در .env.local بگذارید.");
    process.exit(1);
  }

  section("۱) احراز هویت (Keystone)");
  const a = await http("POST", `${AUTH}/auth/tokens`, {
    auth: { identity: { methods: ["application_credential"], application_credential: { id: ID, secret: SECRET } } },
  });
  console.log("HTTP", a.status);
  if (a.status !== 201) {
    console.log("❌ ورود ناموفق:", JSON.stringify(a.json).slice(0, 300));
    process.exit(1);
  }
  TOKEN = a.headers.get("x-subject-token") ?? "";
  const tok = a.json.token as J;
  console.log("✅ توکن گرفته شد. انقضا:", tok.expires_at, "| پروژه:", tok.project?.name, "| نقش‌ها:", (tok.roles ?? []).map((r: J) => r.name).join(","));

  const catalog = (tok.catalog ?? []) as J[];
  const ep = (type: string) => {
    const s = catalog.find((c) => c.type === type);
    const list = ((s?.endpoints ?? []) as J[]).filter((e) => e.interface === "public" && (!REGION || e.region === REGION || e.region_id === REGION));
    return (list[0]?.url as string | undefined)?.replace(/\/+$/, "");
  };
  section("۲) کاتالوگ سرویس‌ها (public)");
  for (const c of catalog) {
    for (const e of c.endpoints as J[]) if (e.interface === "public") console.log(String(c.type).padEnd(16), String(e.region).padEnd(12), e.url);
  }
  const compute = ep("compute"), network = ep("network"), image = ep("image");
  console.log("\ncompute:", compute, "\nnetwork:", network, "\nimage:  ", image);

  await safe("۳) نسخه‌ی Nova (میکروورژن)", async () => {
    const root = compute!.replace(/\/[0-9a-f]{32}$/, "");
    const r = await http("GET", root + "/");
    console.log("HTTP", r.status, JSON.stringify(r.json.version ?? r.json).slice(0, 300));
  });

  await safe("۴) فلورها", async () => {
    const r = await http("GET", `${compute}/flavors/detail`);
    console.log("HTTP", r.status);
    for (const f of (r.json.flavors ?? []) as J[]) {
      console.log(`${f.id}  ${String(f.name).padEnd(14)} vcpu=${f.vcpus} ram=${f.ram}MB disk=${f.disk}GB public=${f["os-flavor-access:is_public"]}`);
    }
  });

  await safe("۵) ایمیج‌ها", async () => {
    const r = await http("GET", `${image}/v2/images?limit=100`);
    console.log("HTTP", r.status);
    for (const i of (r.json.images ?? []) as J[]) {
      console.log(`${i.id}  ${String(i.name).padEnd(24)} ${i.status} ${i.visibility} min_disk=${i.min_disk} agent=${i.hw_qemu_guest_agent ?? "-"} user=${i.os_admin_user ?? i.default_user ?? "-"}`);
    }
  });

  let nets: J[] = [];
  await safe("۶) شبکه‌ها و CIDR", async () => {
    const [n, s] = await Promise.all([http("GET", `${network}/v2.0/networks`), http("GET", `${network}/v2.0/subnets`)]);
    console.log("HTTP", n.status, s.status);
    nets = (n.json.networks ?? []) as J[];
    const subs = (s.json.subnets ?? []) as J[];
    for (const x of nets) {
      const cidrs = subs.filter((q) => q.network_id === x.id).map((q) => `v${q.ip_version}:${q.cidr}`).join(" ");
      console.log(`${x.id}  ${String(x.name).padEnd(18)} shared=${x.shared} ext=${x["router:external"]} ${cidrs}`);
    }
  });

  await safe("۷) آی‌پی آزاد هر شبکه (ممکن است نیاز به دسترسی ادمین داشته باشد)", async () => {
    const r = await http("GET", `${network}/v2.0/network-ip-availabilities`);
    console.log("HTTP", r.status);
    if (r.status !== 200) return console.log("→ در دسترس نیست؛ انتخاب شبکه باید با آزمون‌وخطا (رد شدن شبکه‌ی پر) انجام شود.");
    for (const x of (r.json.network_ip_availabilities ?? []) as J[]) {
      console.log(String(x.network_name).padEnd(18), `used=${x.used_ips}/${x.total_ips}`);
    }
  });

  await safe("۸) گروه‌های امنیتی و قوانین", async () => {
    const r = await http("GET", `${network}/v2.0/security-groups`);
    console.log("HTTP", r.status);
    for (const g of (r.json.security_groups ?? []) as J[]) {
      console.log(`\n• ${g.name} (${g.id})`);
      for (const q of (g.security_group_rules ?? []) as J[]) {
        console.log(`   ${q.direction.padEnd(7)} ${q.ethertype} ${String(q.protocol ?? "any").padEnd(5)} ${q.port_range_min ?? "*"}-${q.port_range_max ?? "*"}  ←→ ${q.remote_ip_prefix ?? q.remote_group_id ?? "any"}`);
      }
    }
  });

  await safe("۹) سهمیه‌ی پروژه (Nova limits)", async () => {
    const r = await http("GET", `${compute}/limits`);
    const l = (r.json.limits?.absolute ?? {}) as J;
    console.log(`سرور: ${l.totalInstancesUsed}/${l.maxTotalInstances}  هسته: ${l.totalCoresUsed}/${l.maxTotalCores}  RAM(MB): ${l.totalRAMUsed}/${l.maxTotalRAMSize}`);
  });

  console.log("\n✅ تمام. این خروجی را (بدون هیچ Secret ای) بفرستید.");
}
main().catch((e) => { console.error(e); process.exit(1); });

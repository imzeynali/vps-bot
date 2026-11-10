import { randomInt } from "node:crypto";
import { config } from "@/core";
import { CgiError, call, sleep } from "./http";

/** لایه‌ی نازک روی Nova / Neutron. هیچ منطق کسب‌وکاری اینجا نیست. همه‌ی توابع ریجن می‌گیرند. */

export interface OsServer {
  id: string;
  name: string;
  status: string; // BUILD / ACTIVE / SHUTOFF / ERROR / REBUILD ...
  addresses: Record<string, Array<{ addr: string; version: number }>>;
  fault?: { message?: string; code?: number };
}

export const ipv4Of = (s: Pick<OsServer, "addresses">): string | null => {
  for (const list of Object.values(s.addresses ?? {})) for (const a of list) if (a.version === 4) return a.addr;
  return null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const g = globalThis as unknown as { __cgiCache?: Map<string, { at: number; v: unknown }> };
async function cached<T>(key: string, ttlMs: number, f: () => Promise<T>): Promise<T> {
  const m = (g.__cgiCache ??= new Map());
  const hit = m.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await f();
  m.set(key, { at: Date.now(), v });
  return v;
}
export const clearCache = () => g.__cgiCache?.clear();

// ───────── Nova ─────────
export async function getServer(region: string, id: string): Promise<OsServer | null> {
  try {
    return (await call<{ server: OsServer }>("compute", "GET", `/servers/${id}`, { region })).json.server;
  } catch (e) {
    if (e instanceof CgiError && e.status === 404) return null;
    throw e;
  }
}

/** جستجو با نام دقیق (فیلتر name در Nova از نوع regex است، پس anchor می‌گذاریم) */
export async function findServersByName(region: string, name: string): Promise<OsServer[]> {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const r = await call<{ servers: OsServer[] }>("compute", "GET", "/servers/detail", { region, query: { name: `^${esc}$` } });
  return r.json.servers ?? [];
}

export interface CreateServerInput {
  name: string;
  flavorRef: string;
  imageRef: string;
  portId: string;
  userDataB64: string;
  metadata?: Record<string, string>;
}
export async function createServer(region: string, i: CreateServerInput): Promise<string> {
  const r = await call<{ server: { id: string } }>("compute", "POST", "/servers", {
    region,
    body: {
      server: {
        name: i.name,
        flavorRef: i.flavorRef,
        imageRef: i.imageRef,
        networks: [{ port: i.portId }],
        user_data: i.userDataB64,
        metadata: i.metadata ?? {},
      },
    },
  });
  return r.json.server.id;
}

export const serverAction = (region: string, id: string, body: unknown) => call("compute", "POST", `/servers/${id}/action`, { region, body });

export async function deleteServer(region: string, id: string): Promise<void> {
  try {
    await call("compute", "DELETE", `/servers/${id}`, { region });
  } catch (e) {
    if (e instanceof CgiError && e.status === 404) return;
    throw e;
  }
}

/** صبر تا حذف کامل سرور (۴۰۴). false = هنوز وجود دارد */
export async function waitGone(region: string, id: string, timeoutMs = 90_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!(await getServer(region, id))) return true;
    await sleep(config.cgi.pollMs);
  }
  return false;
}

export interface Limits {
  instances: [number, number];
  cores: [number, number];
  ramMb: [number, number];
}
export async function limits(region: string): Promise<Limits> {
  const a = (await call<{ limits: { absolute: Record<string, number> } }>("compute", "GET", "/limits", { region })).json.limits.absolute;
  return {
    instances: [a.totalInstancesUsed, a.maxTotalInstances],
    cores: [a.totalCoresUsed, a.maxTotalCores],
    ramMb: [a.totalRAMUsed, a.maxTotalRAMSize],
  };
}

// ───────── نام ← شناسه (هر ریجن شناسه‌های خودش را دارد؛ پلن/OS در دیتابیس با «نام» ذخیره می‌شوند) ─────────
export interface FlavorInfo { id: string; name: string; vcpus: number; ram: number; disk: number }
export const listFlavors = (region: string) =>
  cached(`flv:${region}`, 600_000, async () => {
    const r = await call<{ flavors: Array<Record<string, any>> }>("compute", "GET", "/flavors/detail", { region });
    return (r.json.flavors ?? [])
      .filter((f) => f["os-flavor-access:is_public"] !== false)
      .map((f) => ({ id: f.id, name: f.name, vcpus: f.vcpus, ram: f.ram, disk: f.disk }) as FlavorInfo);
  });

export interface ImageInfo { id: string; name: string }
export const listImages = (region: string) =>
  cached(`img:${region}`, 600_000, async () => {
    const r = await call<{ images: Array<Record<string, any>> }>("image", "GET", "/v2/images", { region, query: { limit: "200" } });
    return (r.json.images ?? []).filter((i) => i.status === "active").map((i) => ({ id: i.id, name: i.name }) as ImageInfo);
  });

/** نام فلور (مثل hostvds-1) یا خودِ UUID را به شناسه‌ی همان ریجن تبدیل می‌کند؛ نبودن = null */
export async function flavorId(region: string, ref: string): Promise<string | null> {
  const list = await listFlavors(region);
  return list.find((f) => f.name === ref)?.id ?? (UUID.test(ref) ? list.find((f) => f.id === ref)?.id ?? null : null);
}
export async function imageId(region: string, ref: string): Promise<string | null> {
  const list = await listImages(region);
  return list.find((i) => i.name === ref)?.id ?? (UUID.test(ref) ? list.find((i) => i.id === ref)?.id ?? null : null);
}

// ───────── Neutron ─────────
export interface Net {
  id: string;
  name: string;
  v4SubnetId: string;
  cidr: string;
}

/** شبکه‌هایی که ساب‌نت IPv4 دارند (کش ۱۰ دقیقه‌ای)، مرتب بر اساس نام */
export const networksWithV4 = (region: string) =>
  cached(`net:${region}`, 600_000, async () => {
    const [n, s] = await Promise.all([
      call<{ networks: Array<{ id: string; name: string }> }>("network", "GET", "/v2.0/networks", { region }),
      call<{ subnets: Array<{ id: string; network_id: string; ip_version: number; cidr: string }> }>("network", "GET", "/v2.0/subnets", { region }),
    ]);
    const nets: Net[] = [];
    for (const x of n.json.networks ?? []) {
      const v4 = (s.json.subnets ?? []).find((q) => q.network_id === x.id && q.ip_version === 4);
      if (v4) nets.push({ id: x.id, name: x.name, v4SubnetId: v4.id, cidr: v4.cidr });
    }
    return nets.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  });

export const securityGroupId = (region: string, name: string) =>
  cached(`sg:${region}:${name}`, 600_000, async () => {
    const r = await call<{ security_groups: Array<{ id: string }> }>("network", "GET", "/v2.0/security-groups", { region, query: { name } });
    const id = r.json.security_groups?.[0]?.id;
    if (!id) throw new CgiError(`گروه امنیتی «${name}» در ریجن ${region} پیدا نشد (CGI_SECURITY_GROUP)`, "config");
    return id;
  });

export interface Port {
  id: string;
  network_id: string;
  device_id?: string;
  fixed_ips: Array<{ ip_address: string; subnet_id: string }>;
}

/** IPv4 پورت (آدرس‌هایی که ':' ندارند) */
export const ipv4OfPort = (p: Pick<Port, "fixed_ips">): string | null => p.fixed_ips?.find((f) => !f.ip_address.includes(":"))?.ip_address ?? null;

export async function findPortByName(region: string, name: string): Promise<Port | null> {
  const r = await call<{ ports: Port[] }>("network", "GET", "/v2.0/ports", { region, query: { name } });
  return r.json.ports?.[0] ?? null;
}

const isNoIp = (e: unknown) =>
  e instanceof CgiError && e.status === 409 && (e.type === "IpAddressGenerationFailure" || /no more ip|ip addresses available/i.test(e.message));

const NO_IP_HINT = "این رنج آی‌پی فعلاً ظرفیت ندارد؛ لطفاً یک شبکه‌ی دیگر را انتخاب کنید.";

async function tryPort(region: string, n: Net, name: string, sgId: string, qos?: string | null): Promise<Port | null> {
  try {
    const r = await call<{ port: Port }>("network", "POST", "/v2.0/ports", {
      region,
      body: { port: { network_id: n.id, name, security_groups: [sgId], ...(qos ? { qos_policy_id: qos } : {}) } },
    });
    if (ipv4OfPort(r.json.port)) return r.json.port;
    await deletePort(region, r.json.port.id).catch(() => {}); // فقط IPv6 گرفت (IPv4 این شبکه پر است) ← پورت را پس بده
    return null;
  } catch (e) {
    if (isNoIp(e)) return null;
    throw e;
  }
}

/**
 * پورت می‌سازد و مطمئن می‌شود IPv4 گرفته است.
 *  - preferredNetwork (نام شبکه‌ای که کاربر انتخاب کرده): فقط همان؛ اگر ظرفیت نداشت خطای قطعی با پیام قابل‌فهم (کاربر رنج دیگری انتخاب کند)
 *  - بدون ترجیح: شبکه‌ها به‌ترتیب تصادفی امتحان می‌شوند و شبکه‌ی پر رد می‌شود
 * ساب‌نت (fixed_ips) را مشخص نمی‌کنیم: سیاست Neutron در HostVDS آن را برای کاربر عادی ممنوع کرده (۴۰۳).
 */
export async function createPortAnywhere(region: string, name: string, sgId: string, preferredNetwork?: string | null, qos?: string | null): Promise<Port> {
  let nets = [...(await networksWithV4(region))];
  if (nets.length === 0) throw new CgiError(`هیچ شبکه‌ی IPv4 در ریجن ${region} پیدا نشد`, "config");
  if (preferredNetwork) {
    nets = nets.filter((n) => n.name.toLowerCase() === preferredNetwork.toLowerCase());
    if (nets.length === 0) throw new CgiError(`شبکه‌ی «${preferredNetwork}» در ریجن ${region} پیدا نشد`, "config", 0, undefined, "شبکه‌ی انتخابی در دسترس نیست؛ لطفاً دوباره تلاش کنید.");
  } else {
    for (let i = nets.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [nets[i], nets[j]] = [nets[j], nets[i]];
    }
  }
  for (const n of nets) {
    const p = await tryPort(region, n, name, sgId, qos);
    if (p) return p;
  }
  throw new CgiError(
    preferredNetwork ? `آی‌پی آزاد IPv4 در شبکه‌ی ${preferredNetwork} باقی نمانده` : "آی‌پی آزاد IPv4 در هیچ‌کدام از شبکه‌های CGI باقی نمانده",
    "http", 409, "IpAddressGenerationFailure", NO_IP_HINT,
  );
}

export async function deletePort(region: string, id: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await call("network", "DELETE", `/v2.0/ports/${id}`, { region });
      return;
    } catch (e) {
      if (e instanceof CgiError && e.status === 404) return;
      if (e instanceof CgiError && e.status === 409 && i < 4) {
        await sleep(config.cgi.pollMs); // هنوز به سرورِ در حال حذف وصل است
        continue;
      }
      throw e;
    }
  }
}

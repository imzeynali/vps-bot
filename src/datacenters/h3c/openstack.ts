import { randomInt } from "node:crypto";
import { config } from "@/core";
import { H3cError, call, sleep } from "./http";

/** لایه‌ی نازک روی Nova / Neutron / Glance / Cinder. هیچ منطق کسب‌وکاری اینجا نیست. همه‌ی توابع ریجن می‌گیرند. */

export interface OsServer {
  id: string;
  name: string;
  status: string; // BUILD / ACTIVE / SHUTOFF / ERROR ...
  addresses: Record<string, Array<{ addr: string; version: number }>>;
  fault?: { message?: string; code?: number };
}

export const ipv4Of = (s: Pick<OsServer, "addresses">): string | null => {
  for (const list of Object.values(s.addresses ?? {})) for (const a of list) if (a.version === 4) return a.addr;
  return null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const g = globalThis as unknown as { __h3cCache?: Map<string, { at: number; v: unknown }> };
async function cached<T>(key: string, ttlMs: number, f: () => Promise<T>): Promise<T> {
  const m = (g.__h3cCache ??= new Map());
  const hit = m.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await f();
  m.set(key, { at: Date.now(), v });
  return v;
}
export const clearCache = () => g.__h3cCache?.clear();

// ───────── Nova ─────────
export async function getServer(region: string, id: string): Promise<OsServer | null> {
  try {
    return (await call<{ server: OsServer }>("compute", "GET", `/servers/${id}`, { region })).json.server;
  } catch (e) {
    if (e instanceof H3cError && e.status === 404) return null;
    throw e;
  }
}

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
  /** اگر فلور دیسک ندارد: ساخت از روی Cinder volume (دیسک سیستم) */
  bootVolume?: { sizeGb: number; volumeType?: string | null };
  az?: string | null;
}

/** بدنه‌ی درخواست ساخت (جدا برای تست‌پذیری) */
export function serverBody(i: CreateServerInput) {
  return {
    server: {
      name: i.name,
      flavorRef: i.flavorRef,
      networks: [{ port: i.portId }],
      user_data: i.userDataB64,
      metadata: i.metadata ?? {},
      ...(i.az ? { availability_zone: i.az } : {}),
      ...(i.bootVolume
        ? {
            block_device_mapping_v2: [
              {
                boot_index: 0,
                uuid: i.imageRef,
                source_type: "image",
                destination_type: "volume",
                volume_size: i.bootVolume.sizeGb,
                delete_on_termination: true, // حذف سرور = حذف دیسک سیستم (بدون هزینه‌ی یتیم)
                ...(i.bootVolume.volumeType ? { volume_type: i.bootVolume.volumeType } : {}),
              },
            ],
          }
        : { imageRef: i.imageRef }),
    },
  };
}

export async function createServer(region: string, i: CreateServerInput): Promise<string> {
  const r = await call<{ server: { id: string } }>("compute", "POST", "/servers", { region, body: serverBody(i) });
  return r.json.server.id;
}

export const serverAction = (region: string, id: string, body: unknown) => call("compute", "POST", `/servers/${id}/action`, { region, body });

export async function deleteServer(region: string, id: string): Promise<void> {
  try {
    await call("compute", "DELETE", `/servers/${id}`, { region });
  } catch (e) {
    if (e instanceof H3cError && e.status === 404) return;
    throw e;
  }
}

export async function waitGone(region: string, id: string, timeoutMs = 90_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!(await getServer(region, id))) return true;
    await sleep(config.h3c.pollMs);
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

// ───────── نام ← شناسه ─────────
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

export async function flavorOf(region: string, ref: string): Promise<FlavorInfo | null> {
  const list = await listFlavors(region);
  return list.find((f) => f.name === ref) ?? (UUID.test(ref) ? list.find((f) => f.id === ref) ?? null : null);
}
export async function imageId(region: string, ref: string): Promise<string | null> {
  const list = await listImages(region);
  return list.find((i) => i.name === ref)?.id ?? (UUID.test(ref) ? list.find((i) => i.id === ref)?.id ?? null : null);
}

/** انواع دیسک Cinder (برای ابزار کشف) */
export async function volumeTypes(region: string): Promise<string[]> {
  const r = await call<{ volume_types: Array<{ name: string }> }>("volume", "GET", "/types", { region });
  return (r.json.volume_types ?? []).map((t) => t.name);
}

// ───────── Neutron ─────────
export interface Net {
  id: string;
  name: string;
  v4SubnetId: string;
  cidr: string;
  external: boolean;
}

/** همه‌ی شبکه‌های دارای ساب‌نت IPv4 (با نشانه‌ی external)، مرتب بر اساس نام — کش ۱۰ دقیقه */
export const allNetworksWithV4 = (region: string) =>
  cached(`net:${region}`, 600_000, async () => {
    const [n, s] = await Promise.all([
      call<{ networks: Array<{ id: string; name: string; "router:external"?: boolean }> }>("network", "GET", "/v2.0/networks", { region }),
      call<{ subnets: Array<{ id: string; network_id: string; ip_version: number; cidr: string }> }>("network", "GET", "/v2.0/subnets", { region }),
    ]);
    const nets: Net[] = [];
    for (const x of n.json.networks ?? []) {
      const v4 = (s.json.subnets ?? []).find((q) => q.network_id === x.id && q.ip_version === 4);
      if (v4) nets.push({ id: x.id, name: x.name, v4SubnetId: v4.id, cidr: v4.cidr, external: x["router:external"] === true });
    }
    return nets.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  });

/**
 * شبکه‌هایی که سرور با آن‌ها IP عمومی می‌گیرد: H3C_NETWORK (نام) اگر تنظیم باشد، وگرنه شبکه‌های router:external.
 * هرگز شبکه‌ی داخلی (خصوصی) انتخاب نمی‌شود، چون کاربر IP خصوصی تحویل می‌گرفت.
 */
export async function publicNetworks(region: string): Promise<Net[]> {
  const all = await allNetworksWithV4(region);
  const nets = config.h3c.network ? all.filter((n) => n.name.toLowerCase() === config.h3c.network.toLowerCase()) : all.filter((n) => n.external);
  if (nets.length === 0) {
    throw new H3cError(
      `شبکه‌ی عمومی IPv4 در ریجن ${region} پیدا نشد؛ H3C_NETWORK را با نام شبکه‌ی خارجی تنظیم کنید (npm run h3c:discover)`,
      "config", 0, undefined, "این لوکیشن فعلاً قابل استفاده نیست.",
    );
  }
  return nets;
}

export const securityGroupId = (region: string, name: string) =>
  cached(`sg:${region}:${name}`, 600_000, async () => {
    const r = await call<{ security_groups: Array<{ id: string }> }>("network", "GET", "/v2.0/security-groups", { region, query: { name } });
    const id = r.json.security_groups?.[0]?.id;
    if (!id) throw new H3cError(`گروه امنیتی «${name}» در ریجن ${region} پیدا نشد (H3C_SECURITY_GROUP؛ در پنل Virtual firewalls بسازید)`, "config");
    return id;
  });

export interface Port {
  id: string;
  network_id: string;
  device_id?: string;
  fixed_ips: Array<{ ip_address: string; subnet_id: string }>;
}
export const ipv4OfPort = (p: Pick<Port, "fixed_ips">): string | null => p.fixed_ips?.find((f) => !f.ip_address.includes(":"))?.ip_address ?? null;

export async function findPortByName(region: string, name: string): Promise<Port | null> {
  const r = await call<{ ports: Port[] }>("network", "GET", "/v2.0/ports", { region, query: { name } });
  return r.json.ports?.[0] ?? null;
}

const isNoIp = (e: unknown) =>
  e instanceof H3cError && e.status === 409 && (e.type === "IpAddressGenerationFailure" || /no more ip|ip addresses available/i.test(e.message));

async function tryPort(region: string, n: Net, name: string, sgId: string): Promise<Port | null> {
  try {
    const r = await call<{ port: Port }>("network", "POST", "/v2.0/ports", { region, body: { port: { network_id: n.id, name, security_groups: [sgId] } } });
    if (ipv4OfPort(r.json.port)) return r.json.port;
    await deletePort(region, r.json.port.id).catch(() => {});
    return null;
  } catch (e) {
    if (isNoIp(e)) return null;
    throw e;
  }
}

/** پورت می‌سازد و مطمئن می‌شود IPv4 گرفته است (شبکه‌ها به ترتیب تصادفی امتحان می‌شوند). */
export async function createPortAnywhere(region: string, name: string, sgId: string): Promise<Port> {
  const nets = [...(await publicNetworks(region))];
  for (let i = nets.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [nets[i], nets[j]] = [nets[j]!, nets[i]!];
  }
  for (const n of nets) {
    const p = await tryPort(region, n, name, sgId);
    if (p) return p;
  }
  throw new H3cError("آی‌پی آزاد IPv4 در شبکه‌های 3HCloud باقی نمانده", "http", 409, "IpAddressGenerationFailure", "ظرفیت آی‌پی این لوکیشن موقتاً تکمیل است.");
}

/** پورت جدا از سرور حذف نمی‌شود و IPv4 آن هزینه دارد (طبق مستندات 3HCloud) ← همیشه صریح پاک می‌کنیم. */
export async function deletePort(region: string, id: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await call("network", "DELETE", `/v2.0/ports/${id}`, { region });
      return;
    } catch (e) {
      if (e instanceof H3cError && e.status === 404) return;
      if (e instanceof H3cError && e.status === 409 && i < 4) {
        await sleep(config.h3c.pollMs);
        continue;
      }
      throw e;
    }
  }
}

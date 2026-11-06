import { randomInt } from "node:crypto";
import { config } from "@/core";
import { CgiError, call, sleep } from "./http";

/** لایه‌ی نازک روی Nova / Neutron. هیچ منطق کسب‌وکاری اینجا نیست. */

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

// ───────── Nova ─────────
export async function getServer(id: string): Promise<OsServer | null> {
  try {
    return (await call<{ server: OsServer }>("compute", "GET", `/servers/${id}`)).json.server;
  } catch (e) {
    if (e instanceof CgiError && e.status === 404) return null;
    throw e;
  }
}

/** جستجو با نام دقیق (فیلتر name در Nova از نوع regex است، پس anchor می‌گذاریم) */
export async function findServersByName(name: string): Promise<OsServer[]> {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const r = await call<{ servers: OsServer[] }>("compute", "GET", "/servers/detail", { query: { name: `^${esc}$` } });
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
export async function createServer(i: CreateServerInput): Promise<string> {
  const r = await call<{ server: { id: string } }>("compute", "POST", "/servers", {
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

export const serverAction = (id: string, body: unknown) => call("compute", "POST", `/servers/${id}/action`, { body });

export async function deleteServer(id: string): Promise<void> {
  try {
    await call("compute", "DELETE", `/servers/${id}`);
  } catch (e) {
    if (e instanceof CgiError && e.status === 404) return;
    throw e;
  }
}

/** صبر تا حذف کامل سرور (۴۰۴). false = هنوز وجود دارد */
export async function waitGone(id: string, timeoutMs = 90_000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (!(await getServer(id))) return true;
    await sleep(config.cgi.pollMs);
  }
  return false;
}

export interface Limits {
  instances: [number, number];
  cores: [number, number];
  ramMb: [number, number];
}
export async function limits(): Promise<Limits> {
  const a = (await call<{ limits: { absolute: Record<string, number> } }>("compute", "GET", "/limits")).json.limits.absolute;
  return {
    instances: [a.totalInstancesUsed, a.maxTotalInstances],
    cores: [a.totalCoresUsed, a.maxTotalCores],
    ramMb: [a.totalRAMUsed, a.maxTotalRAMSize],
  };
}

// ───────── Neutron ─────────
export interface Net {
  id: string;
  name: string;
  v4SubnetId: string;
}
const g = globalThis as unknown as { __cgiNets?: { at: number; nets: Net[] }; __cgiSg?: { at: number; name: string; id: string } };

/** شبکه‌هایی که ساب‌نت IPv4 دارند (کش ۱۰ دقیقه‌ای) */
export async function networksWithV4(): Promise<Net[]> {
  if (g.__cgiNets && Date.now() - g.__cgiNets.at < 600_000) return g.__cgiNets.nets;
  const [n, s] = await Promise.all([
    call<{ networks: Array<{ id: string; name: string }> }>("network", "GET", "/v2.0/networks"),
    call<{ subnets: Array<{ id: string; network_id: string; ip_version: number }> }>("network", "GET", "/v2.0/subnets"),
  ]);
  const nets: Net[] = [];
  for (const x of n.json.networks ?? []) {
    const v4 = (s.json.subnets ?? []).find((q) => q.network_id === x.id && q.ip_version === 4);
    if (v4) nets.push({ id: x.id, name: x.name, v4SubnetId: v4.id });
  }
  g.__cgiNets = { at: Date.now(), nets };
  return nets;
}

export async function securityGroupId(name: string): Promise<string> {
  if (g.__cgiSg && g.__cgiSg.name === name && Date.now() - g.__cgiSg.at < 600_000) return g.__cgiSg.id;
  const r = await call<{ security_groups: Array<{ id: string }> }>("network", "GET", "/v2.0/security-groups", { query: { name } });
  const id = r.json.security_groups?.[0]?.id;
  if (!id) throw new CgiError(`گروه امنیتی «${name}» پیدا نشد (CGI_SECURITY_GROUP)`, "config");
  g.__cgiSg = { at: Date.now(), name, id };
  return id;
}

export interface Port {
  id: string;
  network_id: string;
  device_id?: string;
  fixed_ips: Array<{ ip_address: string; subnet_id: string }>;
}

export async function findPortByName(name: string): Promise<Port | null> {
  const r = await call<{ ports: Port[] }>("network", "GET", "/v2.0/ports", { query: { name } });
  return r.json.ports?.[0] ?? null;
}

const isNoIp = (e: unknown) =>
  e instanceof CgiError && e.status === 409 && (e.type === "IpAddressGenerationFailure" || /no more ip|ip addresses available/i.test(e.message));

/**
 * یک پورت با IPv4 روی یکی از شبکه‌ها می‌سازد. شبکه‌ها به‌ترتیب تصادفی امتحان می‌شوند؛
 * شبکه‌ای که آی‌پی آزاد ندارد (۴۰۹) فوراً رد می‌شود و بعدی امتحان می‌شود (همان خطای «Insufficient IPv4»).
 */
export async function createPortAnywhere(name: string, sgId: string): Promise<Port> {
  const nets = [...(await networksWithV4())];
  if (nets.length === 0) throw new CgiError("هیچ شبکه‌ی IPv4 در CGI پیدا نشد", "config");
  for (let i = nets.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [nets[i], nets[j]] = [nets[j], nets[i]];
  }
  for (const n of nets) {
    try {
      const r = await call<{ port: Port }>("network", "POST", "/v2.0/ports", {
        body: { port: { network_id: n.id, name, security_groups: [sgId], fixed_ips: [{ subnet_id: n.v4SubnetId }] } },
      });
      return r.json.port;
    } catch (e) {
      if (isNoIp(e)) continue;
      throw e;
    }
  }
  throw new CgiError("آی‌پی آزاد IPv4 در هیچ‌کدام از شبکه‌های CGI باقی نمانده", "http", 409, "IpAddressGenerationFailure");
}

export async function deletePort(id: string): Promise<void> {
  for (let i = 0; i < 5; i++) {
    try {
      await call("network", "DELETE", `/v2.0/ports/${id}`);
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

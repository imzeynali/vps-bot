import http from "node:http";
import https from "node:https";
import { randomInt } from "node:crypto";
import { config } from "./config";

/**
 * کلاینت Virtualizor Admin API
 * مستندات: https://www.virtualizor.com/docs/admin-api/
 *   آدرس:   https://HOST:4085/index.php?act=...&api=json&adminapikey=KEY&adminapipass=PASS
 *   ساخت:   act=addvs (POST)         قدرت:  act=vs&action=start|stop|restart|poweroff&vpsid=ID
 *   ریبیلد: act=rebuild (POST)       حذف:   act=vs&delete=ID        لیست: act=vs[&vpsid=..&vpshostname=..]
 */

type Obj = Record<string, any>;

/** kind=panel: پنل پاسخ داد و خطا برگرداند | kind=network: اتصال/timeout/پاسخ نامعتبر (نتیجه عملیات نامشخص) */
export class VirtError extends Error {
  constructor(
    message: string,
    public kind: "panel" | "network" = "panel",
    public raw?: unknown,
  ) {
    super(message);
    this.name = "VirtError";
  }
}

export const isConfigured = () => !!(config.virt.url && config.virt.apiKey && config.virt.apiPass);

// ───────────────────────── HTTP ─────────────────────────
function pairs(prefix: string, v: unknown, out: [string, string][]) {
  if (v === undefined || v === null) return;
  if (Array.isArray(v)) v.forEach((x, i) => pairs(`${prefix}[${i}]`, x, out));
  else if (typeof v === "object") for (const [k, x] of Object.entries(v)) pairs(`${prefix}[${k}]`, x, out);
  else out.push([prefix, String(v)]);
}

export function encodeForm(o: Obj): string {
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(o)) pairs(k, v, out);
  return out.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

function rawRequest(url: URL, method: "GET" | "POST", body: string | undefined, timeoutMs: number) {
  const lib = url.protocol === "https:" ? https : http;
  const options: Obj = {
    method,
    timeout: timeoutMs,
    headers: body
      ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(body) }
      : {},
  };
  if (url.protocol === "https:") options.rejectUnauthorized = !config.virt.insecureTls;

  return new Promise<{ status: number; text: string; location?: string }>((resolve, reject) => {
    const req = lib.request(url, options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          text: Buffer.concat(chunks).toString("utf8"),
          location: res.headers.location,
        }),
      );
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const flatten = (v: unknown): string[] =>
  typeof v === "string" ? [v] : Array.isArray(v) || (v && typeof v === "object") ? Object.values(v as Obj).flatMap(flatten) : [];

/** یک فراخوانی API. در صورت خطا VirtError پرتاب می‌شود. */
export async function vcall(
  act: string,
  opts: { get?: Obj; post?: Obj; timeoutMs?: number } = {},
): Promise<Obj> {
  if (!isConfigured()) {
    throw new VirtError("اتصال Virtualizor تنظیم نشده (VIRT_URL / VIRT_API_KEY / VIRT_API_PASS)", "panel");
  }
  let url: URL;
  try {
    url = new URL(config.virt.url);
  } catch {
    throw new VirtError("VIRT_URL نامعتبر است (مثال: https://panel.example.com:4085)", "panel");
  }
  url.pathname = "/index.php";
  url.search = "";
  url.searchParams.set("act", act);
  url.searchParams.set("api", "json");
  url.searchParams.set("adminapikey", config.virt.apiKey);
  url.searchParams.set("adminapipass", config.virt.apiPass);
  for (const [k, v] of Object.entries(opts.get ?? {})) url.searchParams.set(k, String(v));

  const method = opts.post ? "POST" : "GET";
  const body = opts.post ? encodeForm(opts.post) : undefined;
  const timeout = opts.timeoutMs ?? config.virt.timeoutMs;

  let res;
  try {
    res = await rawRequest(url, method, body, timeout);
    // تا ۳ ریدایرکت روی همان هاست (مثلاً http→https)
    for (let i = 0; i < 3 && res.status >= 300 && res.status < 400 && res.location; i++) {
      const next = new URL(res.location, url);
      if (next.hostname !== url.hostname) break;
      url = next;
      res = await rawRequest(url, method, body, timeout);
    }
  } catch (e) {
    throw new VirtError(`ارتباط با پنل برقرار نشد: ${(e as Error).message}`, "network");
  }

  if (res.status < 200 || res.status >= 300) {
    throw new VirtError(`پنل با وضعیت HTTP ${res.status} پاسخ داد`, "network");
  }

  const start = res.text.indexOf("{");
  let json: Obj;
  try {
    json = JSON.parse(start >= 0 ? res.text.slice(start) : res.text);
  } catch {
    throw new VirtError("پاسخ پنل JSON معتبر نبود (آدرس/پورت یا API Key را بررسی کنید)", "network", res.text.slice(0, 300));
  }

  const errs = flatten(json.error).filter(Boolean);
  if (errs.length) throw new VirtError(errs.join(" | "), "panel", json);
  return json;
}

// ───────────────────────── مدل‌ها ─────────────────────────
export interface VpsInfo {
  vpsid: number;
  hostname: string;
  ips: string[];
  raw: Obj;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

function ipsOf(v: Obj): string[] {
  const out: string[] = [];
  const walk = (x: unknown) => {
    if (typeof x === "string") {
      if (IPV4.test(x.trim())) out.push(x.trim());
    } else if (x && typeof x === "object") Object.values(x as Obj).forEach(walk);
  };
  walk(v.ips);
  walk(v.ip);
  return [...new Set(out)];
}

function toVps(v: Obj): VpsInfo | null {
  const id = Number(v.vpsid ?? v.vps_id);
  if (!Number.isInteger(id) || id <= 0) return null;
  return { vpsid: id, hostname: String(v.hostname ?? ""), ips: ipsOf(v), raw: v };
}

export async function listVps(filter: { vpsid?: number; vpshostname?: string } = {}): Promise<VpsInfo[]> {
  const get: Obj = { search: "Search" };
  if (filter.vpsid) get.vpsid = filter.vpsid;
  if (filter.vpshostname) get.vpshostname = filter.vpshostname;
  const r = await vcall("vs", { get });
  const vs = r.vs && typeof r.vs === "object" ? Object.values(r.vs as Obj) : [];
  return vs.map((x) => toVps(x as Obj)).filter((x): x is VpsInfo => !!x);
}

export async function getVps(vpsid: number): Promise<VpsInfo | null> {
  return (await listVps({ vpsid })).find((v) => v.vpsid === vpsid) ?? null;
}

export async function findByHostname(hostname: string): Promise<VpsInfo | null> {
  return (await listVps({ vpshostname: hostname })).find((v) => v.hostname.toLowerCase() === hostname.toLowerCase()) ?? null;
}

const VNC_CHARS = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const vncPass = () => Array.from({ length: 6 }, () => VNC_CHARS[randomInt(VNC_CHARS.length)]).join("");

export interface CreateVpsInput {
  hostname: string;
  rootpass: string;
  serid: number;
  osid: number;
  ramMb?: number | null; // اگر خالی/صفر باشد، مقدار از Plan پنل (plid) گرفته می‌شود
  cores?: number | null;
  spaceGb?: number | null;
  plid?: number | null;
}

/** ساخت VPS. شناسه VPS برگردانده می‌شود (یا null اگر پنل برنگرداند → از hostname پیدا کنید). */
export async function createVps(p: CreateVpsInput): Promise<{ vpsid: number | null; raw: Obj }> {
  const c = config.virt;
  const post: Obj = {
    addvps: 1,
    virt: c.type,
    serid: p.serid,
    osid: p.osid,
    hostname: p.hostname,
    rootpass: p.rootpass,
    bandwidth: 0, // 0 = نامحدود
    num_ips: 1,
    vnc: 1,
    vncpass: vncPass(), // VNC کوتاه (۶ کاراکتر) تا زیر سقف پنل باشد
  };
  if (p.ramMb) post.ram = p.ramMb;
  if (p.cores) post.cores = p.cores;
  if (p.spaceGb) post.space = c.storageUuid ? [{ size: p.spaceGb, st_uuid: c.storageUuid }] : p.spaceGb;
  if (p.plid) post.plid = p.plid;
  if (c.ipPoolId) post.ippid = c.ipPoolId;
  if (c.ownerUid) post.uid = c.ownerUid;
  else {
    if (!c.ownerEmail || !c.ownerPass) {
      throw new VirtError("VIRT_OWNER_UID یا (VIRT_OWNER_EMAIL و VIRT_OWNER_PASS) تنظیم نشده", "panel");
    }
    post.user_email = c.ownerEmail;
    post.user_pass = c.ownerPass;
  }

  const r = await vcall("addvs", { post });
  const info = (r.vpsinfo ?? (r.done && typeof r.done === "object" ? r.done : null)) as Obj | null;
  const id = Number(info?.vpsid ?? info?.id);
  if (!info && !r.done) {
    throw new VirtError("پنل ساخت VPS را تأیید نکرد", "panel", r);
  }
  return { vpsid: Number.isInteger(id) && id > 0 ? id : null, raw: r };
}

export type PanelPower = "start" | "stop" | "restart" | "poweroff";

export async function powerVps(vpsid: number, action: PanelPower): Promise<void> {
  const r = await vcall("vs", { get: { action, vpsid } });
  if (!r.done && !r.done_msg) throw new VirtError(`پنل عملیات ${action} را تأیید نکرد`, "panel", r);
}

export async function rebuildVps(vpsid: number, osid: number, password: string): Promise<void> {
  const r = await vcall("rebuild", {
    post: { vpsid, reos: 1, osid, newpass: password, conf: password },
  });
  if (!r.done && !r.done_msg) throw new VirtError("پنل ریبیلد را تأیید نکرد", "panel", r);
}

export async function deleteVps(vpsid: number): Promise<void> {
  const r = await vcall("vs", { get: { delete: vpsid }, post: { delete: vpsid } });
  if (!r.done) throw new VirtError("پنل حذف VPS را تأیید نکرد", "panel", r);
}

// ───────────────────────── کشف اطلاعات پنل (برای تنظیمات ادمین) ─────────────────────────
function collect(o: unknown, key: string, out: Obj[] = [], depth = 0): Obj[] {
  if (!o || typeof o !== "object" || depth > 7) return out;
  if (!Array.isArray(o) && key in (o as Obj)) out.push(o as Obj);
  for (const v of Object.values(o as Obj)) collect(v, key, out, depth + 1);
  return out;
}

export interface Discovery {
  ok: boolean;
  error?: string;
  servers: { id: number; name: string; virt: string }[];
  os: { id: number; name: string; virt: string }[];
  plans: { id: number; name: string; virt: string; ramMb: number | null; cores: number | null; spaceGb: number | null }[];
  pools: { id: number; name: string }[];
}

export async function discover(): Promise<Discovery> {
  const d: Discovery = { ok: false, servers: [], os: [], plans: [], pools: [] };
  try {
    await vcall("adminindex", { timeoutMs: 20000 });
  } catch (e) {
    d.error = (e as Error).message;
    return d;
  }
  d.ok = true;
  const safe = async (act: string) => {
    try {
      return await vcall(act, { timeoutMs: 30000 });
    } catch {
      return {};
    }
  };
  const [sv, os, pl, ip] = await Promise.all([safe("servers"), safe("ostemplates"), safe("plans"), safe("ippool")]);

  const seenSrv = new Set<string>();
  for (const x of collect(sv, "serid")) {
    if (x.server_name === undefined) continue;
    const k = `${x.serid}:${x.virt ?? ""}`;
    if (seenSrv.has(k)) continue; // یک Node ممکن است چند بار در پاسخ بیاید
    seenSrv.add(k);
    d.servers.push({ id: Number(x.serid), name: String(x.server_name), virt: String(x.virt ?? "") });
  }

  const seen = new Set<string>();
  for (const x of collect(os, "osid")) {
    if (!x.name) continue;
    const k = `${x.osid}:${x.type ?? x.virt ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    d.os.push({ id: Number(x.osid), name: String(x.name), virt: String(x.type ?? x.virt ?? "") });
  }
  d.os.sort((a, b) => a.name.localeCompare(b.name));

  const pos = (v: unknown) => (Number(v) > 0 ? Number(v) : null);
  const seenPl = new Set<number>();
  for (const x of collect(pl, "plid")) {
    if (x.plan_name === undefined || seenPl.has(Number(x.plid))) continue;
    seenPl.add(Number(x.plid));
    d.plans.push({
      id: Number(x.plid),
      name: String(x.plan_name),
      virt: String(x.virt ?? ""),
      ramMb: pos(x.ram), // مگابایت
      cores: pos(x.cores),
      spaceGb: pos(x.space), // گیگابایت
    });
  }
  d.pools = collect(ip, "ippid")
    .filter((x) => x.ip_pool_name !== undefined)
    .map((x) => ({ id: Number(x.ippid), name: String(x.ip_pool_name) }));
  return d;
}

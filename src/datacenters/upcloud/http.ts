import { config } from "@/core";

export type UpcloudErrorKind = "config" | "auth" | "network" | "http" | "build";

export class UpcloudError extends Error {
  constructor(
    message: string,
    readonly kind: UpcloudErrorKind,
    readonly status = 0,
    readonly code?: string, // error_code خود UpCloud (مثل SERVER_STATE_ILLEGAL)
    /** پیام مناسب نمایش به کاربر نهایی (در متن بازگشت وجه می‌آید) */
    public userHint?: string,
  ) {
    super(message);
    this.name = "UpcloudError";
  }
}

export const isConfigured = () => !!config.upcloud.token;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Json = Record<string, any>;

/**
 * درخواست به API ورژن 1.3 آپ‌کلود. احراز هویت: «Authorization: Bearer ucat_…».
 * GET روی خطای گذرا (502/503/504/قطع شبکه) تا دو بار با backoff تکرار می‌شود؛ عملیات تغییردهنده هرگز خودکار تکرار نمی‌شود.
 * پاسخ 204 (بدون بدنه) = {}.
 */
export async function call<T = Json>(method: string, path: string, body?: unknown, query?: Record<string, string>): Promise<T> {
  if (!isConfigured()) throw new UpcloudError("UPCLOUD_TOKEN تنظیم نشده", "config");
  const retriable = method === "GET";
  const qs = query ? "?" + new URLSearchParams(query).toString() : "";
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try {
      r = await fetch(config.upcloud.apiUrl + path + qs, {
        method,
        headers: {
          Authorization: `Bearer ${config.upcloud.token}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(config.upcloud.timeoutMs),
      });
    } catch (e) {
      if (retriable && attempt < 2) {
        await sleep(500 * 2 ** attempt + Math.random() * 300);
        continue;
      }
      throw new UpcloudError("ارتباط با UpCloud برقرار نشد: " + (e instanceof Error ? e.message : e), "network");
    }
    if (retriable && [502, 503, 504].includes(r.status) && attempt < 2) {
      await sleep(500 * 2 ** attempt + Math.random() * 300);
      continue;
    }
    const text = await r.text();
    let json: Json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* پاسخ غیر JSON */
    }
    if (r.status >= 200 && r.status < 300) return json as T;
    const e = (json.error ?? {}) as Json;
    const msg = String(e.error_message ?? e.message ?? "") || (Object.keys(json).length ? "" : text.replace(/\s+/g, " ").slice(0, 160));
    const code = e.error_code ? String(e.error_code) : undefined;
    if (r.status === 401 || r.status === 403) throw new UpcloudError(`احراز هویت UpCloud رد شد (HTTP ${r.status})${msg ? ": " + msg : ""}`, "auth", r.status, code);
    throw new UpcloudError(`${method} ${path} → HTTP ${r.status}${code ? ` [${code}]` : ""}${msg ? ": " + msg : ""}`, "http", r.status, code, hintOf(code, msg));
  }
}

/** پیام قابل‌نمایش به کاربر برای خطاهای رایج سفارش (اعتبار/سهمیه/زون) */
function hintOf(code: string | undefined, msg: string): string | undefined {
  const t = `${code ?? ""} ${msg}`;
  if (/credit|balance|funds|payment/i.test(t)) return "ظرفیت این لوکیشن موقتاً در دسترس نیست.";
  if (/limit|quota|resource/i.test(t)) return "ظرفیت این لوکیشن موقتاً تکمیل است.";
  if (/zone|plan|template|storage/i.test(t) && /not.?(found|available)|invalid/i.test(t)) return "این پلن یا سیستم‌عامل در این لوکیشن موجود نیست.";
  return undefined;
}

// ───────── کمک‌کننده‌های تجزیه ─────────
/** فهرست داخل پاکت UpCloud: {plans:{plan:[…]}} ← […] (و حالت آرایه‌ی مستقیم) */
export function listIn(j: Json, outer: string, inner: string): Json[] {
  const o = j?.[outer];
  if (Array.isArray(o)) return o;
  const i = o?.[inner];
  return Array.isArray(i) ? i : [];
}

const PRIVATE_V4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const V4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
/** IPv4 عمومی از پاسخ networking: اول اینترفیس type=public، وگرنه هر IPv4 عمومی */
export function publicIpv4(networking: Json): string | null {
  const ifaces = listIn(networking.networking?.interfaces ? { x: networking.networking.interfaces } : {}, "x", "interface");
  const pick = (list: Json[]) => {
    for (const f of list) for (const a of listIn({ x: f.ip_addresses }, "x", "ip_address")) {
      const ip = String(a.address ?? "");
      if ((a.family === "IPv4" || V4.test(ip)) && V4.test(ip) && !PRIVATE_V4.test(ip)) return ip;
    }
    return null;
  };
  return pick(ifaces.filter((f) => f.type === "public")) ?? pick(ifaces);
}

/** پسورد یک‌بارمصرف ساخته‌شده‌ی UpCloud از پاسخ ساخت سرور (فیلد password یا login_user.password؛ نه پسورد VNC) */
export function passwordOf(j: Json): string | null {
  const s = (j.server ?? j) as Json;
  for (const v of [s.password, s.login_user?.password, j.login_user?.password, j.password]) if (typeof v === "string" && v.length >= 6) return v;
  return null;
}

export interface ServerInfo {
  uuid: string;
  state: string;
  hostname: string | null;
  title: string | null;
  zone: string | null;
  raw: Json;
}
export function serverInfo(j: Json): ServerInfo {
  const s = (j.server ?? j) as Json;
  return { uuid: String(s.uuid ?? ""), state: String(s.state ?? ""), hostname: s.hostname ? String(s.hostname) : null, title: s.title ? String(s.title) : null, zone: s.zone ? String(s.zone) : null, raw: s };
}

export async function getServer(uuid: string): Promise<ServerInfo | null> {
  try {
    return serverInfo(await call("GET", `/server/${uuid}`));
  } catch (e) {
    if (e instanceof UpcloudError && e.kind === "http" && e.status === 404) return null;
    throw e;
  }
}

/** فهرست سرورها (فهرست IP و دیسک ندارد؛ فقط uuid/hostname/state/zone). پارامتر limit عمداً فرستاده نمی‌شود: UpCloud مقدار 1000 را رد می‌کند (LIMIT_INVALID). */
export async function listServers(search?: string): Promise<ServerInfo[]> {
  const j = await call("GET", "/server", undefined, search ? { search } : undefined);
  return listIn(j, "servers", "server").map(serverInfo);
}

export async function networkingIp(uuid: string): Promise<string | null> {
  try {
    return publicIpv4(await call("GET", `/server/${uuid}/networking`));
  } catch (e) {
    if (e instanceof UpcloudError && e.kind === "http" && e.status === 404) return null;
    throw e;
  }
}

export interface AccountInfo { username: string; credits: number | null; raw: Json }
export async function account(): Promise<AccountInfo> {
  const a = ((await call("GET", "/account")) as Json).account ?? {};
  return { username: String(a.username ?? ""), credits: a.credits != null && Number.isFinite(Number(a.credits)) ? Number(a.credits) : null, raw: a };
}

export async function waitState(uuid: string, want: string, timeoutMs: number): Promise<ServerInfo> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const s = await getServer(uuid);
    if (!s) throw new UpcloudError("سرور در UpCloud ناپدید شد", "build");
    if (s.state === "error") throw new UpcloudError("سرور در UpCloud به وضعیت error رسید", "build");
    if (s.state === want) return s;
    await sleep(config.upcloud.pollMs);
  }
  throw new UpcloudError(`سرور UpCloud به وضعیت «${want}» نرسید`, "network");
}

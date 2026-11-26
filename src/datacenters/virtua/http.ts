import { config } from "@/core";

export type VirtuaErrorKind = "config" | "auth" | "network" | "http" | "build";

export class VirtuaError extends Error {
  constructor(
    message: string,
    readonly kind: VirtuaErrorKind,
    readonly status = 0,
    /** پیام مناسب نمایش به کاربر نهایی (در متن بازگشت وجه می‌آید) */
    public userHint?: string,
  ) {
    super(message);
    this.name = "VirtuaError";
  }
}

export const isConfigured = () => !!config.virtua.apiKey;
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Json = Record<string, any>;

/**
 * درخواست به API ویرتوا. احراز هویت: هدر «Authorization: Basic <API_KEY>» (کلید خام، مطابق مستندات).
 * بدنه‌ی POST به‌صورت form-urlencoded است (همان‌طور که در مثال‌های curl مستندات ارسال می‌شود).
 * GET روی خطای گذرا (502/503/504/قطع شبکه) تا دو بار با backoff تکرار می‌شود؛ عملیات تغییردهنده هرگز خودکار تکرار نمی‌شود.
 */
export async function call<T = Json>(method: string, path: string, form?: Record<string, string>): Promise<T> {
  if (!isConfigured()) throw new VirtuaError("VIRTUA_API_KEY تنظیم نشده", "config");
  const retriable = method === "GET";
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try {
      r = await fetch(config.virtua.apiUrl + path, {
        method,
        headers: {
          Authorization: `Basic ${config.virtua.apiKey}`,
          Accept: "application/json",
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        },
        body: form ? new URLSearchParams(form).toString() : undefined,
        signal: AbortSignal.timeout(config.virtua.timeoutMs),
      });
    } catch (e) {
      if (retriable && attempt < 2) {
        await sleep(500 * 2 ** attempt + Math.random() * 300);
        continue;
      }
      throw new VirtuaError("ارتباط با Virtua برقرار نشد: " + (e instanceof Error ? e.message : e), "network");
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
    const msg = errorText(json) || (Object.keys(json).length ? "" : text.replace(/\s+/g, " ").slice(0, 160));
    if (r.status === 401 || r.status === 403) throw new VirtuaError(`احراز هویت Virtua رد شد (HTTP ${r.status})${msg ? ": " + msg : ""}`, "auth", r.status);
    if (r.status < 200 || r.status >= 300) throw new VirtuaError(`${method} ${path} → HTTP ${r.status}${msg ? ": " + msg : ""}`, "http", r.status, hintOf(msg));
    // Virtua گاهی با HTTP 200 هم success:false برمی‌گرداند
    if (json.success === false) throw new VirtuaError(`${method} ${path} → ${msg || "success=false"}`, "http", 400, hintOf(msg));
    return json as T;
  }
}

/** متن خطا/پیام از پاسخ (messages[].content یا error/message) */
export function errorText(j: Json): string {
  if (Array.isArray(j.messages)) {
    const t = j.messages.filter((m: Json) => m && m.type !== "notice").map((m: Json) => String(m.content ?? "")).filter(Boolean);
    if (t.length) return t.join("؛ ").slice(0, 200);
  }
  const e = j.error ?? j.message;
  return typeof e === "string" ? e.slice(0, 200) : e && typeof e === "object" ? String((e as Json).message ?? "").slice(0, 200) : "";
}

/** پیام قابل‌نمایش به کاربر برای خطاهای رایج سفارش (موجودی/سهمیه) */
function hintOf(msg: string): string | undefined {
  if (/balance|credit|funds|insufficient/i.test(msg)) return "ظرفیت این لوکیشن موقتاً در دسترس نیست.";
  if (/limit|quota/i.test(msg)) return "ظرفیت این لوکیشن موقتاً تکمیل است.";
  return undefined;
}

// ───────── کمک‌کننده‌های تجزیه (پاسخ‌ها طبق نمونه‌های مستندات؛ نام کلیدها تحمل‌پذیر است) ─────────
const PRIVATE_V4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
const V4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;

/** اولین IPv4 عمومی در جزئیات سرور (کلیدهایی که «ip» یا «addr» دارند اولویت دارند) */
export function ipv4Of(o: unknown): string | null {
  const found: Array<{ ip: string; pri: number }> = [];
  const walk = (v: unknown, key: string) => {
    if (typeof v === "string" && V4.test(v) && !PRIVATE_V4.test(v)) found.push({ ip: v, pri: /ip|addr/i.test(key) ? 0 : 1 });
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(o, "");
  return found.sort((a, b) => a.pri - b.pri)[0]?.ip ?? null;
}

/** پسورد root از جزئیات سرور: ابتدا فیلد تنظیم‌شده (VIRTUA_PASSWORD_FIELD)، وگرنه کلیدی شبیه password */
export function passwordOf(o: Json, field = config.virtua.passwordField): string | null {
  if (field) {
    const v = field.split(".").reduce<any>((a, k) => (a && typeof a === "object" ? a[k] : undefined), o);
    return typeof v === "string" && v ? v : null;
  }
  for (const [k, v] of Object.entries(o)) if (/pass(word)?$|root_pass/i.test(k) && typeof v === "string" && v.length >= 6) return v;
  return null;
}

/** اولین آرایه‌ی شامل آبجکت‌های دارای uuid در پاسخ (کلیدهای مرسوم اولویت دارند) */
export function listOf(j: Json, hints: string[]): Json[] {
  for (const h of hints) if (Array.isArray(j[h])) return j[h];
  for (const v of Object.values(j)) if (Array.isArray(v) && v.length && typeof v[0] === "object" && v[0] && "uuid" in v[0]) return v;
  return Array.isArray(j) ? (j as unknown as Json[]) : [];
}

export interface ServerInfo {
  uuid: string;
  status: string;
  isError: boolean;
  isSetup: boolean;
  isSuspended: boolean;
  hostname: string | null;
  name: string | null;
  raw: Json;
}
export function serverInfo(j: Json): ServerInfo {
  const truthy = (v: unknown) => v === true || v === 1 || v === "1";
  return {
    uuid: String(j.uuid ?? ""),
    status: String(j.status ?? ""),
    isError: truthy(j.is_error),
    isSetup: truthy(j.is_setup),
    isSuspended: truthy(j.is_suspended),
    hostname: j.hostname ? String(j.hostname) : null,
    name: j.name ? String(j.name) : null,
    raw: j,
  };
}

export async function getServer(uuid: string): Promise<ServerInfo | null> {
  try {
    return serverInfo(await call("GET", `/cloud-server/${uuid}`));
  } catch (e) {
    if (e instanceof VirtuaError && e.kind === "http" && (e.status === 404 || e.status === 400)) return null;
    throw e;
  }
}

export async function listServers(): Promise<ServerInfo[]> {
  return listOf(await call("GET", "/cloud-server"), ["cloud_servers", "servers"]).map(serverInfo);
}

export async function limits(): Promise<{ servers: [number, number]; balance: string | null; currency: string }> {
  const [l, a] = await Promise.all([call("GET", "/cloud/limits"), call("GET", "/account").catch(() => ({}) as Json)]);
  return {
    servers: [Number(l.usage?.cloud_servers ?? 0), Number(l.limits?.cloud_servers ?? a.cloud_servers_limit ?? 0)],
    balance: a.balance != null ? String(a.balance) : null,
    currency: String(a.currency ?? "EUR"),
  };
}

export async function projectUuid(): Promise<string> {
  if (config.virtua.project) return config.virtua.project;
  const list = listOf(await call("GET", "/project"), ["projects"]);
  const id = list[0]?.uuid;
  if (!id) throw new VirtuaError("پروژه‌ای در حساب Virtua پیدا نشد؛ VIRTUA_PROJECT را تنظیم کنید", "config");
  return String(id);
}

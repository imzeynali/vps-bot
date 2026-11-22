import { config, logger } from "@/core";

const log = logger("h3c");

export type H3cErrorKind = "config" | "auth" | "network" | "http" | "build";

export class H3cError extends Error {
  constructor(
    message: string,
    readonly kind: H3cErrorKind,
    readonly status = 0,
    readonly type?: string, // نوع خطا در Neutron (مثل IpAddressGenerationFailure)
    /** پیام مناسب نمایش به کاربر نهایی (در متن بازگشت وجه می‌آید) */
    public userHint?: string,
  ) {
    super(message);
    this.name = "H3cError";
  }
}

type Service = "compute" | "network" | "image" | "volume";
const CATALOG_TYPES: Record<Service, string[]> = { compute: ["compute"], network: ["network"], image: ["image"], volume: ["volumev3", "block-storage", "volume"] };
interface Session {
  token: string;
  expiresAt: number;
  catalog: Array<{ type: string; endpoints: Array<{ interface: string; region?: string; region_id?: string; url: string }> }>;
}
const g = globalThis as unknown as { __h3cSessions?: Map<string, Session>; __h3cAuths?: Map<string, Promise<Session>> };

/** نام ریجن (OS_REGION_NAME) ← کد در آدرس Keystone */
export const REGION_CODES: Record<string, string> = { Miami: "mia", Dallas: "dfw", SanFrancisco: "sfo", Warsaw: "waw", Almaty: "ala", Manila: "mnl" };
export const KNOWN_REGIONS = Object.keys(REGION_CODES);

export const isConfigured = () => !!(config.h3c.authUrl && config.h3c.username && config.h3c.password && config.h3c.project);

/** آدرس Keystone یک ریجن: H3C_AUTH_URLS (دستی) ← الگوی H3C_AUTH_URL با {code} ← همان آدرس ثابت. پسوند /v3 خودکار اضافه می‌شود. */
export function authUrlFor(region: string): string {
  let url = "";
  for (const part of config.h3c.authUrls.split(",")) {
    const [k, v] = part.split("=").map((x) => x.trim());
    if (k && v && k.toLowerCase() === region.toLowerCase()) url = v;
  }
  if (!url) {
    if (config.h3c.authUrl.includes("{code}") && !region) throw new H3cError("ریجن مشخص نشده است (H3C_REGION / H3C_REGION_MAP)", "config");
    url = config.h3c.authUrl.replace("{code}", REGION_CODES[region] ?? region.toLowerCase());
  }
  url = url.replace(/\/+$/, "");
  return /\/v3$/.test(url) ? url : url + "/v3";
}

/** Keystone با کاربر API (نام‌کاربری/رمز) و scope پروژه. توکن تا ۵ دقیقه‌ی مانده به انقضا نگه‌داری می‌شود. */
async function authenticate(region: string): Promise<Session> {
  if (!isConfigured()) throw new H3cError("H3C_USERNAME / H3C_PASSWORD / H3C_PROJECT تنظیم نشده", "config");
  const c = config.h3c;
  const project = /^[0-9a-f]{32}$/i.test(c.project) ? { id: c.project } : { name: c.project, domain: { name: c.projectDomain } };
  let r: Response;
  try {
    r = await fetch(`${authUrlFor(region)}/auth/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        auth: { identity: { methods: ["password"], password: { user: { name: c.username, domain: { name: c.userDomain }, password: c.password } } }, scope: { project } },
      }),
      signal: AbortSignal.timeout(c.timeoutMs),
    });
  } catch (e) {
    throw new H3cError(`اتصال به Keystone ${region} برقرار نشد: ` + (e instanceof Error ? e.message : e), "network");
  }
  if (r.status !== 201) {
    // بدنه‌ی پاسخ (مثلاً صفحه‌ی بلاک WAF) برای عیب‌یابی؛ رمز هرگز در پاسخ نیست
    const snippet = (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
    throw new H3cError(`احراز هویت 3HCloud (${region}) ناموفق (HTTP ${r.status})${snippet ? ": " + snippet : ""}`, "auth", r.status);
  }
  const token = r.headers.get("x-subject-token");
  const body = (await r.json()) as { token?: { expires_at?: string; catalog?: Session["catalog"] } };
  if (!token || !body.token) throw new H3cError("پاسخ Keystone نامعتبر است", "auth", r.status);
  log.info("توکن جدید گرفته شد");
  return { token, expiresAt: body.token.expires_at ? Date.parse(body.token.expires_at) : Date.now() + 3600_000, catalog: body.token.catalog ?? [] };
}

/** هر ریجن توکن جدای خودش را دارد (Keystone جدا)؛ احراز هویت هم‌زمان یک‌بار انجام می‌شود (single-flight). */
async function session(region: string): Promise<Session> {
  const sessions = (g.__h3cSessions ??= new Map());
  const auths = (g.__h3cAuths ??= new Map());
  const key = authUrlFor(region);
  const s = sessions.get(key);
  if (s && s.expiresAt - Date.now() > 5 * 60_000) return s;
  let p = auths.get(key);
  if (!p) {
    p = authenticate(region)
      .then((n) => { sessions.set(key, n); return n; })
      .finally(() => auths.delete(key));
    auths.set(key, p);
  }
  return p;
}
export const resetSession = (region?: string) => {
  if (region) g.__h3cSessions?.delete(authUrlFor(region));
  else g.__h3cSessions?.clear();
};

/** «Region» یا «Region/AZ» (ستون dc_ref لوکیشن) ← { region, az } */
export function splitRef(ref: string | null | undefined): { region: string; az: string | null } {
  const [region = "", az] = (ref ?? "").split("/");
  return { region: region || config.h3c.region, az: az || null };
}

function endpoint(s: Session, type: Service, region: string): string {
  const svc = s.catalog.find((c) => CATALOG_TYPES[type].includes(c.type));
  const pub = svc?.endpoints.filter((e) => e.interface === "public") ?? [];
  // اگر کاتالوگ فقط یک ریجن دارد (یا ریجن خالی است) همان را می‌پذیریم
  const ep = pub.find((e) => e.region === region || e.region_id === region) ?? (pub.length === 1 || !region ? pub[0] : undefined);
  if (!ep) throw new H3cError(`سرویس ${type} برای ریجن «${region}» در کاتالوگ 3HCloud پیدا نشد (npm run h3c:discover)`, "config");
  return ep.url.replace(/\/+$/, "");
}

function parseError(j: unknown): { message: string; type?: string } {
  if (j && typeof j === "object") {
    for (const v of Object.values(j as Record<string, unknown>)) {
      if (v && typeof v === "object" && "message" in v) {
        const o = v as { message?: unknown; type?: unknown };
        return { message: String(o.message ?? ""), type: o.type ? String(o.type) : undefined };
      }
    }
  }
  return { message: "" };
}

export interface CallOpts {
  body?: unknown;
  query?: Record<string, string>;
  region?: string;
}

/** کاتالوگ توکن یک ریجن (برای ابزار کشف) */
export async function catalog(region: string): Promise<Session["catalog"]> {
  return (await session(region)).catalog;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET ها روی خطای گذرا (502/503/504 یا قطع شبکه) تا دو بار با backoff تکرار می‌شوند؛ عملیات تغییردهنده هرگز خودکار تکرار نمی‌شود. */
export async function call<T = Record<string, any>>(service: Service, method: string, path: string, opts: CallOpts = {}): Promise<{ status: number; json: T }> {
  const retriable = method === "GET";
  let reauthed = false;
  for (let attempt = 0; ; attempt++) {
    const region = opts.region || config.h3c.region;
    const s = await session(region);
    const qs = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
    let r: Response;
    const url = endpoint(s, service, region) + path + qs;
    try {
      r = await fetch(url, {
        method,
        headers: {
          "X-Auth-Token": s.token,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(service === "compute" ? { "X-OpenStack-Nova-API-Version": config.h3c.novaVersion } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(config.h3c.timeoutMs),
      });
    } catch (e) {
      if (retriable && attempt < 2) {
        await sleep(500 * 2 ** attempt + Math.random() * 300);
        continue;
      }
      throw new H3cError(`ارتباط با ${service} برقرار نشد: ` + (e instanceof Error ? e.message : e), "network");
    }
    if (r.status === 401 && !reauthed) {
      reauthed = true;
      resetSession(region); // توکن باطل شده؛ یک‌بار دوباره احراز هویت
      continue;
    }
    if (retriable && [502, 503, 504].includes(r.status) && attempt < 2) {
      await sleep(500 * 2 ** attempt + Math.random() * 300);
      continue;
    }
    const text = await r.text();
    let json: unknown = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* پاسخ غیر JSON */
    }
    if (r.status >= 200 && r.status < 300) return { status: r.status, json: json as T };
    const pe = parseError(json);
    // اگر پاسخ JSON نبود (مثلاً صفحه‌ی 403 فایروال) خلاصه‌ی بدنه و میزبان را برای عیب‌یابی نشان بده
    const raw = pe.message ? "" : text.replace(/\s+/g, " ").slice(0, 160);
    let host = "";
    try { host = new URL(url).host; } catch { /* */ }
    throw new H3cError(`${service} ${method} ${path} → HTTP ${r.status}${pe.message ? ": " + pe.message : raw ? ": " + raw : ""}${host ? ` [${host}]` : ""}`, "http", r.status, pe.type);
  }
}

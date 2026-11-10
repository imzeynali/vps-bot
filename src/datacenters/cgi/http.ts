import { config, logger } from "@/core";

const log = logger("cgi");

export type CgiErrorKind = "config" | "auth" | "network" | "http" | "build";

export class CgiError extends Error {
  constructor(
    message: string,
    readonly kind: CgiErrorKind,
    readonly status = 0,
    readonly type?: string, // نوع خطا در Neutron (مثل IpAddressGenerationFailure)
    /** پیام مناسب نمایش به کاربر نهایی (در متن بازگشت وجه می‌آید) */
    public userHint?: string,
  ) {
    super(message);
    this.name = "CgiError";
  }
}

type Service = "compute" | "network" | "image";
interface Session {
  token: string;
  expiresAt: number;
  catalog: Array<{ type: string; endpoints: Array<{ interface: string; region?: string; region_id?: string; url: string }> }>;
}
const g = globalThis as unknown as { __cgiSession?: Session; __cgiAuth?: Promise<Session> };

export const isConfigured = () => !!(config.cgi.authUrl && config.cgi.credId && config.cgi.credSecret);

/** احراز هویت Keystone با Application Credential؛ توکن تا ۵ دقیقه‌ی مانده به انقضا نگه‌داری می‌شود */
async function authenticate(): Promise<Session> {
  if (!isConfigured()) throw new CgiError("CGI_AUTH_URL / CGI_APP_CRED_ID / CGI_APP_CRED_SECRET تنظیم نشده", "config");
  let r: Response;
  try {
    r = await fetch(`${config.cgi.authUrl}/auth/tokens`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        auth: { identity: { methods: ["application_credential"], application_credential: { id: config.cgi.credId, secret: config.cgi.credSecret } } },
      }),
      signal: AbortSignal.timeout(config.cgi.timeoutMs),
    });
  } catch (e) {
    throw new CgiError("اتصال به Keystone برقرار نشد: " + (e instanceof Error ? e.message : e), "network");
  }
  if (r.status !== 201) throw new CgiError(`احراز هویت CGI ناموفق (HTTP ${r.status})`, "auth", r.status);
  const token = r.headers.get("x-subject-token");
  const body = (await r.json()) as { token?: { expires_at?: string; catalog?: Session["catalog"] } };
  if (!token || !body.token) throw new CgiError("پاسخ Keystone نامعتبر است", "auth", r.status);
  const s: Session = {
    token,
    expiresAt: body.token.expires_at ? Date.parse(body.token.expires_at) : Date.now() + 3600_000,
    catalog: body.token.catalog ?? [],
  };
  log.info("توکن جدید گرفته شد");
  return s;
}

async function session(force = false): Promise<Session> {
  const s = g.__cgiSession;
  if (!force && s && s.expiresAt - Date.now() > 5 * 60_000) return s;
  if (!g.__cgiAuth) {
    g.__cgiAuth = authenticate()
      .then((n) => (g.__cgiSession = n))
      .finally(() => (g.__cgiAuth = undefined)); // single-flight: درخواست‌های هم‌زمان یک احراز هویت مشترک دارند
  }
  return g.__cgiAuth;
}

export const resetSession = () => {
  g.__cgiSession = undefined;
};

function endpoint(s: Session, type: Service, region: string): string {
  const svc = s.catalog.find((c) => c.type === type);
  const ep = svc?.endpoints.find((e) => e.interface === "public" && (e.region === region || e.region_id === region));
  if (!ep) throw new CgiError(`سرویس ${type} برای ریجن ${region} در کاتالوگ CGI پیدا نشد`, "config");
  return ep.url.replace(/\/+$/, "");
}

/** استخراج پیام خطا از قالب‌های Nova ({"badRequest":{"message"}}) و Neutron ({"NeutronError":{"type","message"}}) */
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
  /** ریجن هدف (پیش‌فرض: CGI_REGION). یک توکن Keystone برای همه‌ی ریجن‌ها معتبر است. */
  region?: string;
}

/** ریجن‌های موجود در کاتالوگ توکن (برای ابزارهای کشف) */
export async function catalogRegions(): Promise<string[]> {
  const s = await session();
  const set = new Set<string>();
  for (const e of s.catalog.find((c) => c.type === "compute")?.endpoints ?? []) if (e.interface === "public" && e.region) set.add(e.region);
  return [...set].sort();
}

export async function call<T = Record<string, any>>(service: Service, method: string, path: string, opts: CallOpts = {}): Promise<{ status: number; json: T }> {
  for (let attempt = 0; ; attempt++) {
    const s = await session(attempt > 0);
    const qs = opts.query ? "?" + new URLSearchParams(opts.query).toString() : "";
    let r: Response;
    try {
      r = await fetch(endpoint(s, service, opts.region ?? config.cgi.region) + path + qs, {
        method,
        headers: {
          "X-Auth-Token": s.token,
          Accept: "application/json",
          ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(service === "compute" ? { "X-OpenStack-Nova-API-Version": config.cgi.novaVersion } : {}),
        },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(config.cgi.timeoutMs),
      });
    } catch (e) {
      throw new CgiError(`ارتباط با ${service} برقرار نشد: ` + (e instanceof Error ? e.message : e), "network");
    }
    if (r.status === 401 && attempt === 0) {
      resetSession(); // توکن باطل شده؛ یک‌بار دوباره احراز هویت
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
    throw new CgiError(`${service} ${method} ${path} → HTTP ${r.status}${pe.message ? ": " + pe.message : ""}`, "http", r.status, pe.type);
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

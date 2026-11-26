import { config, logger, query, queryOne } from "@/core";
import type { DatacenterProvider, PowerAction, ProvisionResult } from "../types";
import { VirtuaError, call, getServer, ipv4Of, isConfigured, limits, listServers, passwordOf, projectUuid, sleep, type ServerInfo } from "./http";

/**
 * Virtua.Cloud (بین‌الملل، فرانسه) — REST API ساده با کلید (https://github.com/Virtua-Cloud/api).
 *  - سفارش: POST /cloud/order {offer, system, project, ipv6_enable, hostname}؛ پلن = offer UUID، سیستم‌عامل = system UUID.
 *  - سرور با hostname یکتا (برای پیدا کردن دوباره‌ی سفارش‌های نیمه‌کاره) ساخته می‌شود.
 *  - مستندات روش تعیین پسورد root را نمی‌گویند: یا از VIRTUA_ORDER_EXTRA (فیلد پسورد سفارش) یا از VIRTUA_PASSWORD_FIELD
 *    (فیلدی از جزئیات سرور) استفاده می‌شود؛ هر دو را «npm run virtua:discover» و «virtua:smoke» مشخص می‌کنند.
 *  - نصب مجدد OS در مستندات عمومی نیست ← پشتیبانی نمی‌شود.
 *  - لوکیشن: locations.dc_ref = UUID پروژه (در services.dc_meta.region ذخیره می‌شود).
 */
const log = logger("virtua");
const hostnameOf = (serviceId: number) => config.vpsHostnameTemplate.replace("{n}", `vt${serviceId}`);

interface Row { external_id: string | null; project: string }
const rowOf = async (serviceId: number): Promise<Row> => {
  const r = await queryOne<{ external_id: string | null; dc_meta: { region?: string } | null }>("SELECT external_id, dc_meta FROM services WHERE id=$1", [serviceId]);
  return { external_id: r?.external_id ?? null, project: r?.dc_meta?.region || config.virtua.project };
};

const ready = (s: ServerInfo) => s.status === "running" && s.isSetup && !s.isError;

async function waitReady(uuid: string): Promise<ServerInfo> {
  const end = Date.now() + config.virtua.buildTimeoutMs;
  while (Date.now() < end) {
    const s = await getServer(uuid);
    if (!s) throw new VirtuaError("سرور در Virtua ناپدید شد", "build");
    if (s.isError) throw new VirtuaError("ساخت سرور در Virtua با خطا مواجه شد", "build");
    if (ready(s)) return s;
    await sleep(config.virtua.pollMs);
  }
  throw new VirtuaError("ساخت سرور در Virtua بیش از حد طول کشید", "network");
}

function orderExtra(password: string): Record<string, string> {
  if (!config.virtua.orderExtra) return {};
  let o: unknown;
  try {
    o = JSON.parse(config.virtua.orderExtra.replaceAll("{password}", password));
  } catch {
    throw new VirtuaError("VIRTUA_ORDER_EXTRA یک JSON معتبر نیست", "config");
  }
  return Object.fromEntries(Object.entries(o as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
}

async function provision(serviceId: number): Promise<ProvisionResult> {
  const s = await queryOne<{ offer: string | null; system: string | null; login_pass: string | null }>(
    `SELECT p.dc_ref AS offer, o.dc_ref AS system, s.login_pass
       FROM services s JOIN plans p ON p.id = s.plan_id LEFT JOIN os_templates o ON o.key = s.os_key WHERE s.id=$1`,
    [serviceId],
  );
  if (!s) throw new VirtuaError("سرویس پیدا نشد", "config");
  if (!s.offer) throw new VirtuaError("پلن این سرویس به offer ویرتوا وصل نیست (plans.dc_ref)", "config");
  if (!s.system) throw new VirtuaError("سیستم‌عامل این سرویس به system ویرتوا وصل نیست (os_templates.dc_ref)", "config");
  if (!s.login_pass) throw new VirtuaError("پسورد سرویس ثبت نشده", "config");

  const { project } = await rowOf(serviceId);
  const hostname = hostnameOf(serviceId);

  // idempotent: سفارش قبلاً ثبت شده (مثلاً timeout بعد از سفارش) ← همان را ادامه بده
  let uuid = (await listServers()).find((x) => x.hostname === hostname)?.uuid;
  if (!uuid) {
    const l = await limits();
    if (l.servers[1] > 0 && l.servers[0] >= l.servers[1]) {
      throw new VirtuaError(`سقف سرور Virtua پر است (${l.servers[0]}/${l.servers[1]})`, "http", 403, "ظرفیت این لوکیشن موقتاً تکمیل است.");
    }
    const extra = orderExtra(s.login_pass);
    const r = await call<{ uuid?: string }>("POST", "/cloud/order", {
      offer: s.offer, system: s.system, project: project || (await projectUuid()), ipv6_enable: "0", hostname, ...extra,
    });
    if (!r.uuid) throw new VirtuaError("پاسخ سفارش Virtua شناسه‌ی سرور ندارد", "http", 502);
    uuid = r.uuid;
  }

  try {
    const info = await waitReady(uuid);
    const ip = ipv4Of(info.raw);
    // پسورد: یا ربات در سفارش فرستاده (VIRTUA_ORDER_EXTRA) یا از جزئیات سرور خوانده می‌شود
    if (!config.virtua.orderExtra) {
      const pw = passwordOf(info.raw);
      if (!pw) throw new VirtuaError("پسورد root از API ویرتوا قابل تعیین/خواندن نیست؛ npm run virtua:discover را ببینید", "build", 0, "تحویل خودکار این سرور هنوز فعال نشده است.");
      if (pw !== s.login_pass) await query("UPDATE services SET login_pass=$1 WHERE id=$2", [pw, serviceId]);
    }
    return { vpsId: null, externalId: uuid, ip, meta: { region: project } };
  } catch (e) {
    if (e instanceof VirtuaError && e.kind === "build") await call("DELETE", `/cloud-server/${uuid}`).catch((x) => log.error("cleanup", x));
    throw e;
  }
}

const PATH: Record<PowerAction, string> = { on: "start", off: "stop", reboot: "restart" };
async function power(serviceId: number, action: PowerAction) {
  const { external_id } = await rowOf(serviceId);
  if (!external_id) throw new VirtuaError("شناسه‌ی این سرور در Virtua ثبت نشده است", "config");
  await call("POST", `/cloud-server/${external_id}/${PATH[action]}`);
}

async function rebuild(): Promise<{ password: string }> {
  throw new VirtuaError("virtua reinstall unsupported", "config", 0, "نصب مجدد سیستم‌عامل برای این دیتاسنتر پشتیبانی نمی‌شود؛ سرور را حذف و دوباره بخرید.");
}

async function remove(serviceId: number) {
  let { external_id } = await rowOf(serviceId);
  if (!external_id) external_id = (await listServers()).find((x) => x.hostname === hostnameOf(serviceId))?.uuid ?? null;
  if (!external_id) return;
  try {
    await call("DELETE", `/cloud-server/${external_id}`);
  } catch (e) {
    if (e instanceof VirtuaError && e.kind === "http" && (e.status === 404 || e.status === 400) && !(await getServer(external_id))) return;
    throw e;
  }
}

async function refreshIp(serviceId: number): Promise<string | null> {
  const { external_id } = await rowOf(serviceId);
  if (!external_id) return null;
  const ip = ipv4Of((await getServer(external_id))?.raw ?? {});
  if (ip) await query("UPDATE services SET ip=$1 WHERE id=$2 AND ip IS DISTINCT FROM $1", [ip, serviceId]);
  return ip;
}

export const virtuaDatacenter: DatacenterProvider = {
  id: "virtua",
  title: "Virtua.Cloud",
  region: "intl",
  implemented: true,

  isConfigured,

  async health() {
    if (!isConfigured()) return { ok: false, detail: "VIRTUA_API_KEY تنظیم نشده" };
    const t0 = Date.now();
    try {
      const l = await limits();
      const warn = l.servers[1] > 0 && l.servers[0] >= l.servers[1] ? " ⚠️ سقف سرور پر است" : "";
      return { ok: true, detail: `سرور ${l.servers[0]}/${l.servers[1]} | موجودی ${l.balance ?? "?"} ${l.currency}${warn}`, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
    }
  },

  provision,
  power,
  rebuild,
  remove,
  refreshIp,

  isDefinitiveFailure(e) {
    if (!(e instanceof VirtuaError)) return false;
    if (e.kind === "config" || e.kind === "build") return true;
    if (e.kind === "http") return e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status);
    return false;
  },

  async removeOrphan(res) {
    if (res.externalId) await call("DELETE", `/cloud-server/${res.externalId}`).catch((e) => log.error("orphan", e));
  },

  async findExisting(serviceId) {
    const hostname = hostnameOf(serviceId);
    const found = (await listServers()).find((x) => x.hostname === hostname);
    if (!found) return null;
    const info = await getServer(found.uuid);
    if (info && ready(info)) {
      const { project } = await rowOf(serviceId);
      return { vpsId: null, externalId: info.uuid, ip: ipv4Of(info.raw), meta: { region: project } };
    }
    await call("DELETE", `/cloud-server/${found.uuid}`).catch((e) => log.error("findExisting cleanup", e));
    return null;
  },
};

import { config, logger, query, queryOne } from "@/core";
import type { DatacenterProvider, PowerAction, ProvisionResult } from "../types";
import { parsePlans } from "./seed";
import { UpcloudError, account, call, getServer, isConfigured, listServers, networkingIp, passwordOf, waitState, type ServerInfo } from "./http";

/**
 * UpCloud (بین‌الملل) — API ورژن 1.3 با توکن Bearer (https://developers.upcloud.com/api/1.3).
 *  - ساخت: POST /server با clone کردن تمپلیت عمومی (storage UUID) روی دیسک هم‌اندازه‌ی پلن؛ فقط اینترفیس public/IPv4.
 *  - پلن = نام پلن UpCloud (مثل 1xCPU-1GB)، سیستم‌عامل = UUID تمپلیت، لوکیشن = زون (dc_ref → dc_meta.region).
 *  - پسورد root: «userdata» (پیش‌فرض) پسورد ربات را با cloud-init (metadata + user_data) می‌گذارد؛
 *    «api» از login_user.create_password پسورد ساخته‌شده‌ی UpCloud را از پاسخ ساخت می‌خواند (فقط یک‌بار نمایش داده می‌شود).
 *  - حذف: UpCloud فقط سرور «متوقف» را حذف می‌کند ← ابتدا stop سخت، بعد DELETE با storages=1 (دیسک هم پاک شود).
 *  - نصب مجدد OS: endpoint دارد ولی دیسک/پسورد جدید می‌خواهد؛ فعلاً پشتیبانی نمی‌شود (سرور را حذف و دوباره بخرید).
 */
const log = logger("upcloud");
const hostnameOf = (serviceId: number) => config.vpsHostnameTemplate.replace("{n}", `up${serviceId}`);

interface Row { external_id: string | null; zone: string }
const rowOf = async (serviceId: number): Promise<Row> => {
  const r = await queryOne<{ external_id: string | null; dc_meta: { region?: string } | null }>("SELECT external_id, dc_meta FROM services WHERE id=$1", [serviceId]);
  return { external_id: r?.external_id ?? null, zone: r?.dc_meta?.region ?? "" };
};

export function buildUserData(password: string): string {
  if (!/^[A-Za-z0-9]+$/.test(password)) throw new UpcloudError("پسورد نامعتبر برای cloud-init", "config");
  return [
    "#cloud-config",
    "disable_root: false",
    "ssh_pwauth: true",
    "runcmd:",
    "  - |",
    `    echo 'root:${password}' | chpasswd`,
    "    mkdir -p /etc/ssh/sshd_config.d",
    "    printf 'PermitRootLogin yes\\nPasswordAuthentication yes\\n' > /etc/ssh/sshd_config.d/00-bot.conf",
    "    sed -i -E 's/^#?PermitRootLogin.*/PermitRootLogin yes/;s/^#?PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config",
    "    systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || service sshd restart",
    "",
  ].join("\n");
}

/** بدنه‌ی درخواست ساخت (جدا برای تست‌پذیری) */
export function serverBody(i: { zone: string; title: string; hostname: string; plan: string; template: string; sizeGb: number; tier: string; password: string }) {
  const api = config.upcloud.passwordMode === "api";
  return {
    server: {
      zone: i.zone,
      title: i.title,
      hostname: i.hostname,
      plan: i.plan,
      metadata: "yes", // تمپلیت‌های cloud-init بدون metadata ساخته نمی‌شوند
      ...(api ? { login_user: { username: "root", create_password: "yes" }, password_delivery: "none" } : { user_data: buildUserData(i.password) }),
      networking: { interfaces: { interface: [{ type: "public", ip_addresses: { ip_address: [{ family: "IPv4" }] } }] } },
      storage_devices: { storage_device: [{ action: "clone", storage: i.template, title: `${i.hostname}-disk0`, size: i.sizeGb, tier: i.tier }] },
    },
  };
}

/** اندازه و tier دیسک هر پلن از GET /plan (کش ۱۰ دقیقه): دیسک باید دقیقاً هم‌اندازه‌ی پلن باشد وگرنه قیمت/پذیرش فرق می‌کند */
const planCache: { at: number; v: Map<string, { diskGb: number; tier: string }> } = { at: 0, v: new Map() };
async function planSpec(name: string): Promise<{ diskGb: number; tier: string } | null> {
  if (Date.now() - planCache.at > 600_000) {
    planCache.v = new Map(parsePlans(await call("GET", "/plan")).map((p) => [p.name, { diskGb: p.diskGb, tier: p.tier }]));
    planCache.at = Date.now();
  }
  return planCache.v.get(name) ?? null;
}

async function provision(serviceId: number): Promise<ProvisionResult> {
  const s = await queryOne<{ plan: string | null; template: string | null; login_pass: string | null; disk_gb: number | null }>(
    `SELECT p.dc_ref AS plan, o.dc_ref AS template, s.login_pass, p.disk_gb
       FROM services s JOIN plans p ON p.id = s.plan_id LEFT JOIN os_templates o ON o.key = s.os_key WHERE s.id=$1`,
    [serviceId],
  );
  if (!s) throw new UpcloudError("سرویس پیدا نشد", "config");
  if (!s.plan) throw new UpcloudError("پلن این سرویس به پلن UpCloud وصل نیست (plans.dc_ref)", "config");
  if (!s.template) throw new UpcloudError("سیستم‌عامل این سرویس به تمپلیت UpCloud وصل نیست (os_templates.dc_ref)", "config");
  if (!s.login_pass) throw new UpcloudError("پسورد سرویس ثبت نشده", "config");
  const { zone } = await rowOf(serviceId);
  if (!zone) throw new UpcloudError("زون این سرویس مشخص نیست (locations.dc_ref)", "config");
  const spec = await planSpec(s.plan);
  const sizeGb = spec?.diskGb || s.disk_gb || 0;
  if (sizeGb <= 0) throw new UpcloudError("اندازه‌ی دیسک پلن مشخص نیست (plans.disk_gb)", "config");
  const tier = spec?.tier || config.upcloud.tier;
  const hostname = hostnameOf(serviceId);

  // idempotent: سفارش قبلاً ثبت شده (مثلاً timeout بعد از ساخت) ← همان را ادامه بده
  let uuid = (await listServers(hostname)).find((x) => x.hostname === hostname)?.uuid;
  if (!uuid) {
    const r = await call<{ server?: { uuid?: string } }>("POST", "/server", serverBody({ zone, title: `bot-${serviceId}`, hostname, plan: s.plan, template: s.template, sizeGb, tier, password: s.login_pass }));
    uuid = r.server?.uuid;
    if (!uuid) throw new UpcloudError("پاسخ ساخت UpCloud شناسه‌ی سرور ندارد", "http", 502);
    // پسورد ساخته‌شده‌ی UpCloud فقط همین‌جا برمی‌گردد ← فوراً ذخیره (قبل از انتظار)
    if (config.upcloud.passwordMode === "api") {
      const pw = passwordOf(r);
      if (!pw) {
        await cleanup(uuid);
        throw new UpcloudError("UpCloud پسورد root را در پاسخ ساخت برنگرداند؛ UPCLOUD_PASSWORD_MODE=userdata را امتحان کنید", "build", 0, undefined, "تحویل خودکار این سرور هنوز فعال نشده است.");
      }
      if (pw !== s.login_pass) await query("UPDATE services SET login_pass=$1 WHERE id=$2", [pw, serviceId]);
    }
  }

  try {
    await waitState(uuid, "started", config.upcloud.buildTimeoutMs);
    const ip = await networkingIp(uuid);
    if (!ip) throw new UpcloudError("آدرس IPv4 عمومی برای سرور UpCloud پیدا نشد", "build");
    return { vpsId: null, externalId: uuid, ip, meta: { region: zone } };
  } catch (e) {
    if (e instanceof UpcloudError && e.kind === "build") await cleanup(uuid);
    throw e;
  }
}

/** توقف سخت + حذف با دیسک‌ها (UpCloud سرور روشن را حذف نمی‌کند) */
async function cleanup(uuid: string): Promise<void> {
  try {
    const s = await getServer(uuid);
    if (!s) return;
    if (s.state !== "stopped") {
      if (s.state === "maintenance") await waitState(uuid, "started", 120_000).catch(() => undefined); // در حال ساخت/تغییر ← اجازه بده تمام شود
      await call("POST", `/server/${uuid}/stop`, { stop_server: { stop_type: "hard" } }).catch((e) => log.error("stop", e));
      await waitState(uuid, "stopped", 90_000);
    }
    await call("DELETE", `/server/${uuid}`, undefined, { storages: "1" });
  } catch (e) {
    if (e instanceof UpcloudError && e.kind === "http" && e.status === 404) return;
    log.error("cleanup", e);
    throw e;
  }
}

async function power(serviceId: number, action: PowerAction) {
  const { external_id } = await rowOf(serviceId);
  if (!external_id) throw new UpcloudError("شناسه‌ی این سرور در UpCloud ثبت نشده است", "config");
  if (action === "on") await call("POST", `/server/${external_id}/start`);
  else if (action === "off") await call("POST", `/server/${external_id}/stop`, { stop_server: { stop_type: "soft", timeout: "60" } });
  else await call("POST", `/server/${external_id}/restart`, { restart_server: { stop_type: "soft", timeout: "60", timeout_action: "destroy" } });
}

async function rebuild(): Promise<{ password: string }> {
  throw new UpcloudError("upcloud reinstall unsupported", "config", 0, undefined, "نصب مجدد سیستم‌عامل برای UpCloud پشتیبانی نمی‌شود؛ سرور را حذف و دوباره بخرید.");
}

async function remove(serviceId: number) {
  let { external_id } = await rowOf(serviceId);
  if (!external_id) external_id = (await listServers(hostnameOf(serviceId))).find((x: ServerInfo) => x.hostname === hostnameOf(serviceId))?.uuid ?? null;
  if (!external_id) return;
  await cleanup(external_id);
}

async function refreshIp(serviceId: number): Promise<string | null> {
  const { external_id } = await rowOf(serviceId);
  if (!external_id) return null;
  const ip = await networkingIp(external_id);
  if (ip) await query("UPDATE services SET ip=$1 WHERE id=$2 AND ip IS DISTINCT FROM $1", [ip, serviceId]);
  return ip;
}

export const upcloudDatacenter: DatacenterProvider = {
  id: "upcloud",
  title: "UpCloud",
  region: "intl",
  implemented: true,

  isConfigured,

  async health() {
    if (!isConfigured()) return { ok: false, detail: "UPCLOUD_TOKEN تنظیم نشده" };
    const t0 = Date.now();
    try {
      const a = await account();
      const servers = (await listServers()).length;
      return { ok: true, detail: `حساب ${a.username} | اعتبار ${a.credits != null ? (a.credits / 100).toFixed(2) : "?"} | سرورها ${servers}`, ms: Date.now() - t0 };
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
    if (!(e instanceof UpcloudError)) return false;
    if (e.kind === "config" || e.kind === "build") return true;
    if (e.kind === "http") return e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status);
    return false;
  },

  async removeOrphan(res) {
    if (res.externalId) await cleanup(res.externalId).catch((e) => log.error("orphan", e));
  },

  async findExisting(serviceId) {
    const hostname = hostnameOf(serviceId);
    const found = (await listServers(hostname)).find((x) => x.hostname === hostname);
    if (!found) return null;
    const info = await getServer(found.uuid);
    if (info?.state === "started") {
      const ip = await networkingIp(info.uuid);
      if (ip) return { vpsId: null, externalId: info.uuid, ip, meta: { region: info.zone ?? (await rowOf(serviceId)).zone } };
    }
    await cleanup(found.uuid).catch((e) => log.error("findExisting cleanup", e));
    return null;
  },
};

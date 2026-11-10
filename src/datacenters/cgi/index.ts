import { config, genPassword, logger, query, queryOne } from "@/core";
import type { DatacenterProvider, PowerAction, ProvisionResult } from "../types";
import { CgiError, isConfigured, sleep } from "./http";
import * as OS from "./openstack";

/**
 * CGI (بین‌الملل) — HostVDS / OpenStack (Keystone + Nova + Neutron)، چندریجنی. بدون Cinder (دیسک ریشه در خود فلور است).
 * ریجن و شبکه‌ی انتخابیِ کاربر در services.dc_meta ذخیره می‌شود: { region, network }.
 * ساخت: پورت IPv4 روی شبکه‌ی انتخابی ← سرور با آن پورت ← انتظار تا ACTIVE. پسورد root با cloud-init (user_data).
 * پلن/OS در دیتابیس با «نام» (hostvds-1 / Ubuntu-24.04-amd64) ذخیره می‌شوند و در هر ریجن به شناسه‌ی همان ریجن تبدیل می‌شوند.
 */
const log = logger("cgi");

const nameFor = (serviceId: number) => `tcg-${serviceId}`;

/** cloud-init: پسورد root + باز کردن ورود root با رمز روی SSH (ایمیج‌های Ubuntu پیش‌فرض آن را می‌بندند) */
export function buildUserData(password: string): string {
  if (!/^[A-Za-z0-9]+$/.test(password)) throw new CgiError("پسورد نامعتبر برای cloud-init", "config");
  const yaml = [
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
  return Buffer.from(yaml, "utf8").toString("base64");
}

interface Meta { region?: string; network?: string; bandwidth?: number; qos?: string; port_id?: string | null; network_id?: string | null }
interface Row { external_id: string | null; meta: Meta; ip: string | null; region: string }
const rowOf = async (serviceId: number): Promise<Row> => {
  const r = await queryOne<{ external_id: string | null; dc_meta: Meta | null; ip: string | null }>(
    "SELECT external_id, dc_meta, ip FROM services WHERE id=$1",
    [serviceId],
  );
  const meta = r?.dc_meta ?? {};
  return { external_id: r?.external_id ?? null, meta, ip: r?.ip ?? null, region: meta.region || config.cgi.region };
};

async function quotaCheck(region: string) {
  const l = await OS.limits(region);
  if (l.instances[0] >= l.instances[1]) {
    throw new CgiError(`سهمیه‌ی سرور در CGI (${region}) پر است (${l.instances[0]}/${l.instances[1]})`, "http", 403, undefined, "ظرفیت این لوکیشن موقتاً تکمیل است.");
  }
  // هسته/رم را خود Nova هنگام ساخت بررسی می‌کند؛ خطای آن ۴۰۳ قطعی است
}

/** تا ACTIVE شدن صبر می‌کند. ERROR ← خطای قطعی. timeout ← خطای نامشخص (recoverStuck بعداً بررسی می‌کند) */
async function waitActive(region: string, serverId: string, portIp: string | null): Promise<string | null> {
  const end = Date.now() + config.cgi.buildTimeoutMs;
  while (Date.now() < end) {
    const s = await OS.getServer(region, serverId);
    if (!s) throw new CgiError("سرور در CGI ناپدید شد", "build");
    if (s.status === "ERROR") throw new CgiError("ساخت در CGI به ERROR رسید: " + (s.fault?.message ?? "نامشخص"), "build");
    if (s.status === "ACTIVE") return OS.ipv4Of(s) ?? portIp;
    await sleep(config.cgi.pollMs);
  }
  throw new CgiError("ساخت سرور در CGI بیش از حد طول کشید", "network");
}

async function cleanup(region: string, serverId: string | null, portId: string | null) {
  if (serverId) {
    await OS.deleteServer(region, serverId).catch((e) => log.error("cleanup server", e));
    await OS.waitGone(region, serverId, 60_000).catch(() => false);
  }
  if (portId) await OS.deletePort(region, portId).catch((e) => log.error("cleanup port", e));
}

const metaOf = async (region: string, port: OS.Port | null): Promise<Record<string, unknown>> => {
  const net = port ? (await OS.networksWithV4(region).catch(() => [])).find((n) => n.id === port.network_id) : undefined;
  return { region, network: net?.name ?? null, network_id: port?.network_id ?? null, port_id: port?.id ?? null };
};

async function provision(serviceId: number): Promise<ProvisionResult> {
  const s = await queryOne<{ flavor: string | null; image: string | null; login_pass: string | null }>(
    `SELECT p.dc_ref AS flavor, o.dc_ref AS image, s.login_pass
       FROM services s JOIN plans p ON p.id = s.plan_id LEFT JOIN os_templates o ON o.key = s.os_key
      WHERE s.id=$1`,
    [serviceId],
  );
  if (!s) throw new CgiError("سرویس پیدا نشد", "config");
  if (!s.flavor) throw new CgiError("پلن این سرویس به فلور CGI وصل نیست (plans.dc_ref)", "config");
  if (!s.image) throw new CgiError("سیستم‌عامل این سرویس به ایمیج CGI وصل نیست (os_templates.dc_ref)", "config");
  if (!s.login_pass) throw new CgiError("پسورد سرویس ثبت نشده", "config");

  const { region, meta } = await rowOf(serviceId);
  const name = nameFor(serviceId);

  // idempotent: اگر قبلاً ساخته شده (مثلاً timeout بعد از ساخت) همان را ادامه بده
  let server = (await OS.findServersByName(region, name))[0];
  let port = await OS.findPortByName(region, name);

  if (!server) {
    const [flavorRef, imageRef] = await Promise.all([OS.flavorId(region, s.flavor), OS.imageId(region, s.image)]);
    if (!flavorRef) throw new CgiError(`فلور «${s.flavor}» در ریجن ${region} وجود ندارد`, "config", 0, undefined, "این پلن در این لوکیشن موجود نیست.");
    if (!imageRef) throw new CgiError(`ایمیج «${s.image}» در ریجن ${region} وجود ندارد`, "config", 0, undefined, "این سیستم‌عامل در این لوکیشن موجود نیست.");
    await quotaCheck(region);
    if (!port) port = await OS.createPortAnywhere(region, name, await OS.securityGroupId(region, config.cgi.securityGroup), meta.network ?? null, meta.qos ?? null);
    try {
      const id = await OS.createServer(region, {
        name,
        flavorRef,
        imageRef,
        portId: port.id,
        userDataB64: buildUserData(s.login_pass),
        metadata: { bot_service: String(serviceId) },
      });
      server = { id, name, status: "BUILD", addresses: {} };
    } catch (e) {
      // ساخت رد شد (۴xx قطعی) ← پورت را آزاد کن؛ خطای نامشخص (۵xx/timeout) ← پورت بماند تا تلاش بعدی/بازیابی همان را پیدا کند
      if (e instanceof CgiError && e.kind === "http" && e.status >= 400 && e.status < 500) await OS.deletePort(region, port.id).catch(() => {});
      throw e;
    }
  }

  try {
    const ip = await waitActive(region, server.id, port ? OS.ipv4OfPort(port) : null);
    return { vpsId: null, externalId: server.id, ip, meta: await metaOf(region, port) };
  } catch (e) {
    if (e instanceof CgiError && e.kind === "build") await cleanup(region, server.id, port?.id ?? null);
    throw e;
  }
}

const ACTIONS: Record<PowerAction, unknown> = { on: { "os-start": null }, off: { "os-stop": null }, reboot: { reboot: { type: "SOFT" } } };
const TARGET: Record<PowerAction, string | null> = { on: "ACTIVE", off: "SHUTOFF", reboot: null };

async function power(serviceId: number, action: PowerAction) {
  const { external_id, region } = await rowOf(serviceId);
  if (!external_id) throw new CgiError("شناسه‌ی این سرور در CGI ثبت نشده است", "config");
  try {
    await OS.serverAction(region, external_id, ACTIONS[action]);
  } catch (e) {
    // ۴۰۹ = سرور از قبل در همان وضعیت است (مثلاً خاموش کردنِ سرور خاموش) ← موفق حساب می‌شود
    if (e instanceof CgiError && e.status === 409 && TARGET[action]) {
      if ((await OS.getServer(region, external_id))?.status === TARGET[action]) return;
    }
    throw e;
  }
}

async function rebuild(serviceId: number, osKey: string) {
  const { external_id, region } = await rowOf(serviceId);
  if (!external_id) throw new CgiError("شناسه‌ی این سرور در CGI ثبت نشده است", "config");
  const o = await queryOne<{ dc_ref: string | null }>("SELECT dc_ref FROM os_templates WHERE key=$1", [osKey]);
  const imageRef = o?.dc_ref ? await OS.imageId(region, o.dc_ref) : null;
  if (!imageRef) throw new CgiError("سیستم‌عامل در کاتالوگ این ریجن پیدا نشد", "config");
  const password = genPassword();
  await OS.serverAction(region, external_id, { rebuild: { imageRef, user_data: buildUserData(password) } });
  return { password };
}

async function remove(serviceId: number) {
  const r = await rowOf(serviceId);
  const name = nameFor(serviceId);
  let serverId = r.external_id;
  if (!serverId) serverId = (await OS.findServersByName(r.region, name))[0]?.id ?? null; // ساخته شده ولی ثبت نشده
  let portId = r.meta.port_id ?? null;
  if (!portId) portId = (await OS.findPortByName(r.region, name))?.id ?? null;
  if (!serverId && !portId) return; // هیچ‌وقت ساخته نشده
  if (serverId) {
    await OS.deleteServer(r.region, serverId);
    await OS.waitGone(r.region, serverId, 90_000); // پورت تا حذف کامل سرور آزاد نمی‌شود
  }
  if (portId) await OS.deletePort(r.region, portId); // پورتِ ساخته‌ی خودمان با حذف سرور پاک نمی‌شود
}

async function refreshIp(serviceId: number): Promise<string | null> {
  const r = await rowOf(serviceId);
  if (!r.external_id) return null;
  const ip = OS.ipv4Of((await OS.getServer(r.region, r.external_id)) ?? { addresses: {} });
  if (ip && ip !== r.ip) await query("UPDATE services SET ip=$1 WHERE id=$2", [ip, serviceId]);
  return ip;
}

/** ریجن‌های فعال (لوکیشن‌های فعال CGI + ریجن پیش‌فرض) */
export async function activeRegions(): Promise<string[]> {
  const rows = await query<{ dc_ref: string }>("SELECT DISTINCT dc_ref FROM locations WHERE datacenter='cgi' AND active AND dc_ref IS NOT NULL");
  return [...new Set([config.cgi.region, ...rows.map((r) => r.dc_ref)])];
}

export const cgiDatacenter: DatacenterProvider = {
  id: "cgi",
  title: "CGI",
  region: "intl",
  implemented: true,

  isConfigured,

  async health() {
    if (!isConfigured()) return { ok: false, detail: "CGI_AUTH_URL / CGI_APP_CRED_ID / CGI_APP_CRED_SECRET تنظیم نشده" };
    const t0 = Date.now();
    try {
      const parts: string[] = [];
      for (const region of await activeRegions()) {
        const [l, nets] = await Promise.all([OS.limits(region), OS.networksWithV4(region)]);
        parts.push(`${region}: سرور ${l.instances[0]}/${l.instances[1]} | هسته ${l.cores[0]}/${l.cores[1]} | رم ${Math.round(l.ramMb[0] / 1024)}/${Math.round(l.ramMb[1] / 1024)}GB | ${nets.length} شبکه‌ی IPv4`);
      }
      return { ok: true, detail: parts.join("\n"), ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e), ms: Date.now() - t0 };
    }
  },

  provision,
  power,
  rebuild,
  remove,
  refreshIp,

  /** قطعی: هیچ سروری ساخته نشده/پاک شده (۴xx جز ۴۰۱/۴۰۸/۴۲۹، ERROR، تنظیمات ناقص) ← بازگشت وجه. بقیه نامشخص. */
  isDefinitiveFailure(e) {
    if (!(e instanceof CgiError)) return false;
    if (e.kind === "config" || e.kind === "build") return true;
    if (e.kind === "http") return e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status);
    return false;
  },

  async removeOrphan(res) {
    const region = (res.meta?.region as string | undefined) || config.cgi.region;
    await cleanup(region, res.externalId ?? null, (res.meta?.port_id as string | undefined) ?? null);
  },

  /** سرویسِ گیرکرده: اگر سرور ACTIVE است برگردان؛ اگر ERROR/گیرکرده در BUILD است پاکش کن (تا هزینه‌ی بی‌صاحب نماند) و null بده (بازگشت وجه) */
  async findExisting(serviceId) {
    const { region } = await rowOf(serviceId);
    const name = nameFor(serviceId);
    const s = (await OS.findServersByName(region, name))[0];
    const port = await OS.findPortByName(region, name);
    if (s?.status === "ACTIVE") {
      return { vpsId: null, externalId: s.id, ip: OS.ipv4Of(s) ?? (port ? OS.ipv4OfPort(port) : null), meta: await metaOf(region, port) };
    }
    await cleanup(region, s?.id ?? null, port?.id ?? null);
    return null;
  },
};

/** اطلاعات کاتالوگ برای منوی خرید (بدون وابستگی منوی ربات به جزئیات OpenStack) */
export const cgiCatalog = {
  hasFlavor: async (region: string, ref: string) => !!(await OS.flavorId(region, ref)),
  hasImage: async (region: string, ref: string) => !!(await OS.imageId(region, ref)),
  /** شبکه‌های IPv4 ریجن (نام + رنج) مرتب‌شده بر اساس نام */
  networks: async (region: string) => (await OS.networksWithV4(region)).map((n) => ({ name: n.name, cidr: n.cidr })),
};

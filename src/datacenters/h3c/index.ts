import { config, genPassword, logger, query, queryOne } from "@/core";
import type { DatacenterProvider, PowerAction, ProvisionResult } from "../types";
import { H3cError, isConfigured, sleep, splitRef } from "./http";
import * as OS from "./openstack";

/**
 * 3HCloud (بین‌الملل) — OpenStack (Keystone + Nova + Neutron + Glance + Cinder)، چندریجنی.
 * تفاوت‌ها با CGI/HostVDS (طبق مستندات 3HCloud):
 *  - احراز هویت با «کاربر API» (نام‌کاربری/رمز + پروژه)، نه Application Credential.
 *  - دیسک سیستم یک volume جداست؛ اگر فلور دیسک ندارد (disk=0) از روی ایمیج volume ساخته می‌شود (block_device_mapping_v2).
 *  - نصب مجدد OS پشتیبانی نمی‌شود (باید سرور حذف و دوباره ساخته شود).
 *  - خاموش بودن (SHUTOFF) هزینه را متوقف نمی‌کند؛ پورتِ جدا از سرور حذف نمی‌شود و IPv4 آن هزینه دارد (پس همیشه پورت را پاک می‌کنیم).
 *  - سهمیه در سطح ریجن است (بین Zoneهای همان ریجن مشترک).
 * لوکیشن: locations.dc_ref = «Region» یا «Region/AZ»؛ در services.dc_meta.region ذخیره می‌شود.
 */
const log = logger("h3c");
const nameFor = (serviceId: number) => `h3c-${serviceId}`;

export function buildUserData(password: string): string {
  if (!/^[A-Za-z0-9]+$/.test(password)) throw new H3cError("پسورد نامعتبر برای cloud-init", "config");
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

interface Meta { region?: string; port_id?: string | null; network?: string | null; network_id?: string | null }
interface Row { external_id: string | null; meta: Meta; ip: string | null; ref: string; region: string; az: string | null }
const rowOf = async (serviceId: number): Promise<Row> => {
  const r = await queryOne<{ external_id: string | null; dc_meta: Meta | null; ip: string | null }>("SELECT external_id, dc_meta, ip FROM services WHERE id=$1", [serviceId]);
  const meta = r?.dc_meta ?? {};
  const ref = meta.region || config.h3c.region;
  return { external_id: r?.external_id ?? null, meta, ip: r?.ip ?? null, ref, ...splitRef(ref) };
};

async function quotaCheck(region: string) {
  const l = await OS.limits(region);
  if (l.instances[0] >= l.instances[1]) {
    throw new H3cError(`سهمیه‌ی سرور در 3HCloud (${region}) پر است (${l.instances[0]}/${l.instances[1]})`, "http", 403, undefined, "ظرفیت این لوکیشن موقتاً تکمیل است.");
  }
}

async function waitActive(region: string, serverId: string, portIp: string | null): Promise<string | null> {
  const end = Date.now() + config.h3c.buildTimeoutMs;
  while (Date.now() < end) {
    const s = await OS.getServer(region, serverId);
    if (!s) throw new H3cError("سرور در 3HCloud ناپدید شد", "build");
    if (s.status === "ERROR") throw new H3cError("ساخت در 3HCloud به ERROR رسید: " + (s.fault?.message ?? "نامشخص"), "build");
    if (s.status === "ACTIVE") return OS.ipv4Of(s) ?? portIp;
    await sleep(config.h3c.pollMs);
  }
  throw new H3cError("ساخت سرور در 3HCloud بیش از حد طول کشید", "network");
}

async function cleanup(region: string, serverId: string | null, portId: string | null) {
  if (serverId) {
    await OS.deleteServer(region, serverId).catch((e) => log.error("cleanup server", e));
    await OS.waitGone(region, serverId, 60_000).catch(() => false);
  }
  if (portId) await OS.deletePort(region, portId).catch((e) => log.error("cleanup port", e));
}

const metaOf = async (ref: string, region: string, port: OS.Port | null): Promise<Record<string, unknown>> => {
  const net = port ? (await OS.allNetworksWithV4(region).catch(() => [])).find((n) => n.id === port.network_id) : undefined;
  return { region: ref, network: net?.name ?? null, network_id: port?.network_id ?? null, port_id: port?.id ?? null };
};

async function provision(serviceId: number): Promise<ProvisionResult> {
  const s = await queryOne<{ flavor: string | null; image: string | null; login_pass: string | null; disk_gb: number | null }>(
    `SELECT p.dc_ref AS flavor, o.dc_ref AS image, s.login_pass, p.disk_gb
       FROM services s JOIN plans p ON p.id = s.plan_id LEFT JOIN os_templates o ON o.key = s.os_key
      WHERE s.id=$1`,
    [serviceId],
  );
  if (!s) throw new H3cError("سرویس پیدا نشد", "config");
  if (!s.flavor) throw new H3cError("پلن این سرویس به فلور 3HCloud وصل نیست (plans.dc_ref)", "config");
  if (!s.image) throw new H3cError("سیستم‌عامل این سرویس به ایمیج 3HCloud وصل نیست (os_templates.dc_ref)", "config");
  if (!s.login_pass) throw new H3cError("پسورد سرویس ثبت نشده", "config");

  const { ref, region, az } = await rowOf(serviceId);
  const name = nameFor(serviceId);

  // idempotent: اگر قبلاً ساخته شده (مثلاً timeout بعد از ساخت) همان را ادامه بده
  let server = (await OS.findServersByName(region, name))[0];
  let port = await OS.findPortByName(region, name);

  if (!server) {
    const [flavor, imageRef] = await Promise.all([OS.flavorOf(region, s.flavor), OS.imageId(region, s.image)]);
    if (!flavor) throw new H3cError(`فلور «${s.flavor}» در ریجن ${region} وجود ندارد`, "config", 0, undefined, "این پلن در این لوکیشن موجود نیست.");
    if (!imageRef) throw new H3cError(`ایمیج «${s.image}» در ریجن ${region} وجود ندارد`, "config", 0, undefined, "این سیستم‌عامل در این لوکیشن موجود نیست.");
    await quotaCheck(region);
    if (!port) port = await OS.createPortAnywhere(region, name, await OS.securityGroupId(region, config.h3c.securityGroup));
    try {
      const id = await OS.createServer(region, {
        name,
        flavorRef: flavor.id,
        imageRef,
        portId: port.id,
        userDataB64: buildUserData(s.login_pass),
        metadata: { bot_service: String(serviceId) },
        az,
        bootVolume: flavor.disk > 0 ? undefined : { sizeGb: s.disk_gb && s.disk_gb > 0 ? s.disk_gb : config.h3c.diskGb, volumeType: config.h3c.volumeType || null },
      });
      server = { id, name, status: "BUILD", addresses: {} };
    } catch (e) {
      // ۴xx قطعی ← پورت را آزاد کن (IPv4 جدامانده هزینه دارد)؛ ۵xx/timeout نامشخص ← پورت بماند
      if (e instanceof H3cError && e.kind === "http" && e.status >= 400 && e.status < 500) await OS.deletePort(region, port.id).catch(() => {});
      throw e;
    }
  }

  try {
    const ip = await waitActive(region, server.id, port ? OS.ipv4OfPort(port) : null);
    return { vpsId: null, externalId: server.id, ip, meta: await metaOf(ref, region, port) };
  } catch (e) {
    if (e instanceof H3cError && e.kind === "build") await cleanup(region, server.id, port?.id ?? null);
    throw e;
  }
}

const ACTIONS: Record<PowerAction, unknown> = { on: { "os-start": null }, off: { "os-stop": null }, reboot: { reboot: { type: "SOFT" } } };
const TARGET: Record<PowerAction, string | null> = { on: "ACTIVE", off: "SHUTOFF", reboot: null };

async function power(serviceId: number, action: PowerAction) {
  const { external_id, region } = await rowOf(serviceId);
  if (!external_id) throw new H3cError("شناسه‌ی این سرور در 3HCloud ثبت نشده است", "config");
  try {
    await OS.serverAction(region, external_id, ACTIONS[action]);
  } catch (e) {
    if (e instanceof H3cError && e.status === 409 && TARGET[action]) {
      if ((await OS.getServer(region, external_id))?.status === TARGET[action]) return;
    }
    throw e;
  }
}

/** 3HCloud نصب مجدد OS را پشتیبانی نمی‌کند (مستندات: سرور باید حذف و دوباره ساخته شود). */
async function rebuild(): Promise<{ password: string }> {
  throw new H3cError("3HCloud reinstall unsupported", "config", 0, undefined, "نصب مجدد سیستم‌عامل برای 3HCloud پشتیبانی نمی‌شود؛ سرور را حذف و دوباره بخرید.");
}

async function remove(serviceId: number) {
  const r = await rowOf(serviceId);
  const name = nameFor(serviceId);
  let serverId = r.external_id;
  if (!serverId) serverId = (await OS.findServersByName(r.region, name))[0]?.id ?? null;
  let portId = r.meta.port_id ?? null;
  if (!portId) portId = (await OS.findPortByName(r.region, name))?.id ?? null;
  if (!serverId && !portId) return;
  if (serverId) {
    await OS.deleteServer(r.region, serverId);
    await OS.waitGone(r.region, serverId, 120_000); // پورت تا حذف کامل سرور آزاد نمی‌شود
  }
  if (portId) await OS.deletePort(r.region, portId);
}

async function refreshIp(serviceId: number): Promise<string | null> {
  const r = await rowOf(serviceId);
  if (!r.external_id) return null;
  const ip = OS.ipv4Of((await OS.getServer(r.region, r.external_id)) ?? { addresses: {} });
  if (ip && ip !== r.ip) await query("UPDATE services SET ip=$1 WHERE id=$2", [ip, serviceId]);
  return ip;
}

/** ریجن‌های فعال (لوکیشن‌های فعال 3HCloud + ریجن پیش‌فرض) */
export async function activeRegions(): Promise<string[]> {
  const rows = await query<{ dc_ref: string }>("SELECT DISTINCT dc_ref FROM locations WHERE datacenter='h3c' AND active AND dc_ref IS NOT NULL");
  return [...new Set([config.h3c.region, ...rows.map((r) => splitRef(r.dc_ref).region)].filter(Boolean))];
}

export const h3cDatacenter: DatacenterProvider = {
  id: "h3c",
  title: "3HCloud",
  region: "intl",
  implemented: true,

  isConfigured,

  async health() {
    if (!isConfigured()) return { ok: false, detail: "H3C_AUTH_URL / H3C_USERNAME / H3C_PASSWORD / H3C_PROJECT تنظیم نشده" };
    const t0 = Date.now();
    try {
      const parts: string[] = [];
      for (const region of await activeRegions()) {
        const l = await OS.limits(region);
        const nets = await OS.publicNetworks(region).then((n) => `${n.length} شبکه‌ی عمومی`, () => "شبکه‌ی عمومی پیدا نشد");
        parts.push(`${region}: سرور ${l.instances[0]}/${l.instances[1]} | هسته ${l.cores[0]}/${l.cores[1]} | رم ${Math.round(l.ramMb[0] / 1024)}/${Math.round(l.ramMb[1] / 1024)}GB | ${nets}`);
      }
      return { ok: true, detail: parts.join("\n") || "متصل (هنوز لوکیشنی نگاشت نشده)", ms: Date.now() - t0 };
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
    if (!(e instanceof H3cError)) return false;
    if (e.kind === "config" || e.kind === "build") return true;
    if (e.kind === "http") return e.status >= 400 && e.status < 500 && ![401, 408, 429].includes(e.status);
    return false;
  },

  async removeOrphan(res) {
    const { region } = splitRef((res.meta?.region as string | undefined) || config.h3c.region);
    await cleanup(region, res.externalId ?? null, (res.meta?.port_id as string | undefined) ?? null);
  },

  async findExisting(serviceId) {
    const { ref, region } = await rowOf(serviceId);
    const name = nameFor(serviceId);
    const s = (await OS.findServersByName(region, name))[0];
    const port = await OS.findPortByName(region, name);
    if (s?.status === "ACTIVE") {
      return { vpsId: null, externalId: s.id, ip: OS.ipv4Of(s) ?? (port ? OS.ipv4OfPort(port) : null), meta: await metaOf(ref, region, port) };
    }
    await cleanup(region, s?.id ?? null, port?.id ?? null);
    return null;
  },
};

void genPassword;

import { randomInt } from "node:crypto";
import { config } from "./config";
import { query, queryOne } from "./db";
import * as V from "./virtualizor";

/**
 * لایه اتصال به ارائه‌دهنده سرور: Virtualizor (Admin API).
 * همه توابع بر اساس «شناسه سرویس در دیتابیس ربات» کار می‌کنند و شناسه VPS در پنل
 * (services.vps_id) را خودشان پیدا می‌کنند.
 */

export type PowerAction = "on" | "off" | "reboot";

const ALPHA = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** پسورد ۱۶ کاراکتری با حروف کوچک/بزرگ و عدد (بدون کاراکتر خاص تا روی همه OSها مشکلی نداشته باشد) */
export function genPassword(len = 16): string {
  for (;;) {
    let p = "";
    for (let i = 0; i < len; i++) p += ALPHA[randomInt(ALPHA.length)];
    if (/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p)) return p;
  }
}

export const hostnameFor = (serviceId: number) => `s${serviceId}.${config.vpsDomain}`;

async function vpsIdOf(serviceId: number): Promise<number> {
  const r = await queryOne<{ vps_id: number | null }>("SELECT vps_id FROM services WHERE id=$1", [serviceId]);
  if (!r?.vps_id) throw new V.VirtError("شناسه این سرور در پنل ثبت نشده است", "panel");
  return r.vps_id;
}

async function osidOf(osKey: string): Promise<number> {
  const r = await queryOne<{ osid: number }>("SELECT osid FROM os_templates WHERE key=$1", [osKey]);
  if (!r) throw new V.VirtError("سیستم‌عامل در کاتالوگ پیدا نشد", "panel");
  return r.osid;
}

export interface ProvisionResult {
  vpsId: number;
  ip: string | null;
}

/** ساخت سرور برای سرویسِ در حال provisioning. اگر VPS با همین hostname قبلاً ساخته شده باشد همان را برمی‌گرداند. */
export async function provisionServer(serviceId: number): Promise<ProvisionResult> {
  const s = await queryOne<{
    cpu: number;
    ram_gb: number;
    disk_gb: number;
    virt_plid: number | null;
    serid: number | null;
    osid: number | null;
    login_pass: string | null;
  }>(
    `SELECT p.cpu, p.ram_gb, p.disk_gb, p.virt_plid, l.serid, o.osid, s.login_pass
       FROM services s
       JOIN plans p ON p.id = s.plan_id
       LEFT JOIN locations l ON l.key = s.location_key
       LEFT JOIN os_templates o ON o.key = s.os_key
      WHERE s.id=$1`,
    [serviceId],
  );
  if (!s) throw new V.VirtError("سرویس پیدا نشد", "panel");
  if (s.serid === null || s.osid === null) throw new V.VirtError("لوکیشن یا سیستم‌عامل در کاتالوگ پیدا نشد", "panel");
  if (!s.login_pass) throw new V.VirtError("پسورد سرویس ثبت نشده", "panel");

  const hostname = hostnameFor(serviceId);
  let vps = await V.findByHostname(hostname);

  if (!vps) {
    const r = await V.createVps({
      hostname,
      rootpass: s.login_pass,
      serid: s.serid,
      osid: s.osid,
      ramMb: s.ram_gb * 1024,
      cores: s.cpu,
      spaceGb: s.disk_gb,
      plid: s.virt_plid,
    });
    if (r.vpsid) vps = (await V.getVps(r.vpsid)) ?? { vpsid: r.vpsid, hostname, ips: [], raw: {} };
    else vps = await V.findByHostname(hostname);
    if (!vps) throw new V.VirtError("VPS ساخته شد اما شناسه آن از پنل دریافت نشد", "network", r.raw);
  }

  // IP معمولاً همان لحظه تخصیص داده می‌شود؛ چند بار تلاش کوتاه
  let ip: string | null = vps.ips[0] ?? null;
  for (let i = 0; i < 4 && !ip; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    ip = (await V.getVps(vps.vpsid).catch(() => null))?.ips[0] ?? null;
  }
  return { vpsId: vps.vpsid, ip };
}

const POWER_MAP = { on: "start", off: "poweroff", reboot: "restart" } as const;

export async function powerAction(serviceId: number, action: PowerAction): Promise<void> {
  await V.powerVps(await vpsIdOf(serviceId), POWER_MAP[action]);
}

export async function rebuildServer(serviceId: number, osKey: string): Promise<{ password: string }> {
  const vpsId = await vpsIdOf(serviceId);
  const osid = await osidOf(osKey);
  const password = genPassword();
  await V.rebuildVps(vpsId, osid, password);
  return { password };
}

const GONE = /not\s*(exist|found)|no such|invalid\s*vps|does not/i;

export async function deleteServer(serviceId: number): Promise<void> {
  const r = await queryOne<{ vps_id: number | null }>("SELECT vps_id FROM services WHERE id=$1", [serviceId]);
  if (!r?.vps_id) return; // هیچ‌وقت روی پنل ساخته نشده
  try {
    await V.deleteVps(r.vps_id);
  } catch (e) {
    if (e instanceof V.VirtError && e.kind === "panel" && GONE.test(e.message)) return; // قبلاً حذف شده
    throw e;
  }
}

/** برای نمایش: اگر IP هنوز ثبت نشده بود از پنل بگیر */
export async function refreshIp(serviceId: number): Promise<string | null> {
  const r = await queryOne<{ vps_id: number | null; ip: string | null }>(
    "SELECT vps_id, ip FROM services WHERE id=$1",
    [serviceId],
  );
  if (!r?.vps_id) return null;
  const ip = (await V.getVps(r.vps_id))?.ips[0] ?? null;
  if (ip && ip !== r.ip) await query("UPDATE services SET ip=$1 WHERE id=$2", [ip, serviceId]);
  return ip;
}


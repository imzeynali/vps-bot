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

/** شماره‌ی اختصاصی سرویس: userStart + id − 1  (id=1 → 1001) */
export const seqOf = (serviceId: number) => config.virt.userStart + serviceId - 1;

/** مثلاً tetacloud.s1001.com (بر اساس VPS_HOSTNAME_TEMPLATE) */
export const hostnameFor = (serviceId: number) =>
  config.vpsHostnameTemplate
    .replace(/\{n\}/g, String(seqOf(serviceId)))
    .replace(/\{id\}/g, String(serviceId))
    .replace(/\{domain\}/g, config.vpsDomain)
    .toLowerCase();

/** مثلاً tetaclouduser1001@mizban.com ؛ اگر VIRT_USER_DOMAIN تنظیم نباشد null */
export const panelEmailFor = (serviceId: number): string | null =>
  config.virt.userDomain ? `${config.virt.userPrefix}${seqOf(serviceId)}@${config.virt.userDomain}`.toLowerCase() : null;

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
    ram_mb: number | null;
    disk_gb: number;
    virt_plid: number | null;
    serid: number | null;
    osid: number | null;
    login_pass: string | null;
    panel_pass: string | null;
  }>(
    `SELECT p.cpu, p.ram_gb, p.ram_mb, p.disk_gb, p.virt_plid, l.serid, o.osid, s.login_pass, s.panel_pass
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
  const userEmail = panelEmailFor(serviceId);
  if (userEmail) {
    if (!s.panel_pass) throw new V.VirtError("پسورد کاربر پنل برای این سرویس ثبت نشده", "panel");
    await query("UPDATE services SET panel_email=$1 WHERE id=$2", [userEmail, serviceId]);
  }
  let vps = await V.findByHostname(hostname);

  if (!vps) {
    const r = await V.createVps({
      hostname,
      rootpass: s.login_pass,
      serid: s.serid,
      osid: s.osid,
      ramMb: s.ram_mb ?? (s.ram_gb ? s.ram_gb * 1024 : null),
      cores: s.cpu || null,
      spaceGb: s.disk_gb || null,
      plid: s.virt_plid,
      userEmail: userEmail ?? undefined,
      userPass: userEmail ? (s.panel_pass ?? undefined) : undefined,
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


export interface ImportedPlan {
  id: number;
  name: string;
  plid: number;
  created: boolean;
}

/** پلن‌های Virtualizor (فقط نوع kvm) را وارد پلن‌های ربات می‌کند. پلن‌های جدید با قیمت ۰ و غیرفعال ساخته می‌شوند تا ادمین قیمت بدهد. */
export async function importPanelPlans(): Promise<ImportedPlan[]> {
  const d = await V.discover();
  if (!d.ok) throw new V.VirtError(d.error ?? "اتصال به پنل برقرار نشد", "network");
  const out: ImportedPlan[] = [];
  for (const p of d.plans) {
    if (p.virt && p.virt !== config.virt.type) continue;
    const ex = await queryOne<{ id: number; name: string }>("SELECT id, name FROM plans WHERE virt_plid=$1 ORDER BY id LIMIT 1", [p.id]);
    if (ex) {
      out.push({ id: ex.id, name: ex.name, plid: p.id, created: false });
      continue;
    }
    const row = await queryOne<{ id: number }>(
      `INSERT INTO plans (name, cpu, ram_gb, ram_mb, disk_gb, hourly_price, active, virt_plid)
       VALUES ($1,$2,$3,$4,$5,0,FALSE,$6) RETURNING id`,
      [p.name, p.cores ?? 0, p.ramMb ? Math.max(1, Math.round(p.ramMb / 1024)) : 0, p.ramMb, p.spaceGb ?? 0, p.id],
    );
    out.push({ id: row!.id, name: p.name, plid: p.id, created: true });
  }
  return out;
}

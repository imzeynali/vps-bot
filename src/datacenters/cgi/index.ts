import { config, genPassword, logger, query, queryOne } from "@/core";
import type { DatacenterProvider, PowerAction, ProvisionResult } from "../types";
import { CgiError, isConfigured, sleep } from "./http";
import * as OS from "./openstack";

/**
 * CGI (بین‌الملل) — HostVDS / OpenStack (Keystone + Nova + Neutron). بدون Cinder (دیسک ریشه در خود فلور است).
 * ساخت: پورت IPv4 روی یکی از شبکه‌های عمومی ← سرور با آن پورت ← انتظار تا ACTIVE.
 * پسورد root با cloud-init (user_data) تنظیم می‌شود.
 */
const log = logger("cgi");

const nameFor = (serviceId: number) => `tcg-${serviceId}`;

/** cloud-init: پسورد root + باز کردن ورود root با رمز روی SSH (ایمیج‌های Ubuntu/Debian/... پیش‌فرض آن را می‌بندند) */
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

interface Row {
  external_id: string | null;
  dc_meta: { port_id?: string; network_id?: string } | null;
  ip: string | null;
}
const rowOf = async (serviceId: number): Promise<Row> =>
  (await queryOne<Row>("SELECT external_id, dc_meta, ip FROM services WHERE id=$1", [serviceId])) ?? { external_id: null, dc_meta: null, ip: null };

async function quotaCheck() {
  const l = await OS.limits();
  if (l.instances[0] >= l.instances[1]) throw new CgiError(`سهمیه‌ی سرور در CGI پر است (${l.instances[0]}/${l.instances[1]})`, "http", 403);
  // هسته/رم را خود Nova هنگام ساخت بررسی می‌کند؛ خطای آن ۴۰۳ قطعی است
}

/** تا ACTIVE شدن صبر می‌کند. ERROR ← پاکسازی و خطای قطعی. timeout ← خطای نامشخص (recoverStuck بعداً بررسی می‌کند) */
async function waitActive(serverId: string, portIp: string | null): Promise<string | null> {
  const end = Date.now() + config.cgi.buildTimeoutMs;
  while (Date.now() < end) {
    const s = await OS.getServer(serverId);
    if (!s) throw new CgiError("سرور در CGI ناپدید شد", "build");
    if (s.status === "ERROR") throw new CgiError("ساخت در CGI به ERROR رسید: " + (s.fault?.message ?? "نامشخص"), "build");
    if (s.status === "ACTIVE") return OS.ipv4Of(s) ?? portIp;
    await sleep(config.cgi.pollMs);
  }
  throw new CgiError("ساخت سرور در CGI بیش از حد طول کشید", "network");
}

async function cleanup(serverId: string | null, portId: string | null) {
  if (serverId) {
    await OS.deleteServer(serverId).catch((e) => log.error("cleanup server", e));
    await OS.waitGone(serverId, 60_000).catch(() => false);
  }
  if (portId) await OS.deletePort(portId).catch((e) => log.error("cleanup port", e));
}

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

  const name = nameFor(serviceId);

  // idempotent: اگر قبلاً ساخته شده (مثلاً timeout بعد از ساخت) همان را ادامه بده
  let server = (await OS.findServersByName(name))[0];
  let port = await OS.findPortByName(name);

  if (!server) {
    await quotaCheck();
    if (!port) port = await OS.createPortAnywhere(name, await OS.securityGroupId(config.cgi.securityGroup));
    try {
      const id = await OS.createServer({
        name,
        flavorRef: s.flavor,
        imageRef: s.image,
        portId: port.id,
        userDataB64: buildUserData(s.login_pass),
        metadata: { bot_service: String(serviceId) },
      });
      server = { id, name, status: "BUILD", addresses: {} };
    } catch (e) {
      // ساخت رد شد (۴xx قطعی) ← پورت را آزاد کن؛ خطای نامشخص (۵xx/timeout) ← پورت بماند تا تلاش بعدی/بازیابی همان را پیدا کند
      if (e instanceof CgiError && e.kind === "http" && e.status >= 400 && e.status < 500) await OS.deletePort(port.id).catch(() => {});
      throw e;
    }
  }

  const portIp = port?.fixed_ips?.[0]?.ip_address ?? null;
  try {
    const ip = await waitActive(server.id, portIp);
    return { vpsId: null, externalId: server.id, ip, meta: { port_id: port?.id ?? null, network_id: port?.network_id ?? null } };
  } catch (e) {
    if (e instanceof CgiError && e.kind === "build") await cleanup(server.id, port?.id ?? null);
    throw e;
  }
}

const ACTIONS: Record<PowerAction, unknown> = { on: { "os-start": null }, off: { "os-stop": null }, reboot: { reboot: { type: "SOFT" } } };
const TARGET: Record<PowerAction, string | null> = { on: "ACTIVE", off: "SHUTOFF", reboot: null };

async function power(serviceId: number, action: PowerAction) {
  const { external_id } = await rowOf(serviceId);
  if (!external_id) throw new CgiError("شناسه‌ی این سرور در CGI ثبت نشده است", "config");
  try {
    await OS.serverAction(external_id, ACTIONS[action]);
  } catch (e) {
    // ۴۰۹ = سرور از قبل در همان وضعیت است (مثلاً خاموش کردنِ سرور خاموش) ← موفق حساب می‌شود
    if (e instanceof CgiError && e.status === 409 && TARGET[action]) {
      if ((await OS.getServer(external_id))?.status === TARGET[action]) return;
    }
    throw e;
  }
}

async function rebuild(serviceId: number, osKey: string) {
  const { external_id } = await rowOf(serviceId);
  if (!external_id) throw new CgiError("شناسه‌ی این سرور در CGI ثبت نشده است", "config");
  const o = await queryOne<{ dc_ref: string | null }>("SELECT dc_ref FROM os_templates WHERE key=$1", [osKey]);
  if (!o?.dc_ref) throw new CgiError("سیستم‌عامل در کاتالوگ CGI پیدا نشد", "config");
  const password = genPassword();
  await OS.serverAction(external_id, { rebuild: { imageRef: o.dc_ref, user_data: buildUserData(password) } });
  return { password };
}

async function remove(serviceId: number) {
  const r = await rowOf(serviceId);
  const name = nameFor(serviceId);
  let serverId = r.external_id;
  if (!serverId) serverId = (await OS.findServersByName(name))[0]?.id ?? null; // ساخته شده ولی ثبت نشده
  let portId = r.dc_meta?.port_id ?? null;
  if (!portId) portId = (await OS.findPortByName(name))?.id ?? null;
  if (!serverId && !portId) return; // هیچ‌وقت ساخته نشده
  if (serverId) {
    await OS.deleteServer(serverId);
    await OS.waitGone(serverId, 90_000); // پورت تا حذف کامل سرور آزاد نمی‌شود
  }
  if (portId) await OS.deletePort(portId); // پورتِ ساخته‌ی خودمان با حذف سرور پاک نمی‌شود
}

async function refreshIp(serviceId: number): Promise<string | null> {
  const r = await rowOf(serviceId);
  if (!r.external_id) return null;
  const ip = OS.ipv4Of((await OS.getServer(r.external_id)) ?? { addresses: {} });
  if (ip && ip !== r.ip) await query("UPDATE services SET ip=$1 WHERE id=$2", [ip, serviceId]);
  return ip;
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
      const [l, nets] = await Promise.all([OS.limits(), OS.networksWithV4()]);
      return {
        ok: true,
        detail: `ریجن ${config.cgi.region} | سرور ${l.instances[0]}/${l.instances[1]} | هسته ${l.cores[0]}/${l.cores[1]} | رم ${Math.round(l.ramMb[0] / 1024)}/${Math.round(l.ramMb[1] / 1024)}GB | ${nets.length} شبکه‌ی IPv4`,
        ms: Date.now() - t0,
      };
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
    await cleanup(res.externalId ?? null, (res.meta?.port_id as string | undefined) ?? null);
  },

  /** سرویسِ گیرکرده: اگر سرور ACTIVE است برگردان؛ اگر ERROR/گیرکرده در BUILD است پاکش کن (تا هزینه‌ی بی‌صاحب نماند) و null بده (بازگشت وجه) */
  async findExisting(serviceId) {
    const name = nameFor(serviceId);
    const s = (await OS.findServersByName(name))[0];
    const port = await OS.findPortByName(name);
    if (s?.status === "ACTIVE") {
      return {
        vpsId: null,
        externalId: s.id,
        ip: OS.ipv4Of(s) ?? port?.fixed_ips?.[0]?.ip_address ?? null,
        meta: { port_id: port?.id ?? null, network_id: port?.network_id ?? null },
      };
    }
    await cleanup(s?.id ?? null, port?.id ?? null);
    return null;
  },
};

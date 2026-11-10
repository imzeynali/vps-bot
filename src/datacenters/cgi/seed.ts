import { config, query, queryOne } from "@/core";
import { call } from "./http";

/**
 * کاتالوگ CGI را از خود API می‌خواند و در جدول‌های ربات می‌ریزد (idempotent؛ چندبار اجرا امن است).
 * پلن‌ها و OSها با «نام» ذخیره می‌شوند (hostvds-1، Ubuntu-24.04-amd64) تا در هر ریجن به شناسه‌ی همان ریجن وصل شوند.
 *  - پلن‌ها: همه‌ی فلورها ساخته می‌شوند؛ فقط hostvds-1/2/4 فعال و قیمت‌دار می‌شوند (و فقط اگر هنوز قیمت ندارند)
 *  - سیستم‌عامل‌ها: فقط Ubuntu 20/22/24 (بقیه غیرفعال)
 *  - لوکیشن‌ها: پاریس، هلند، لاتویا، فنلاند — با نگاشت CGI_REGION_MAP (مثلاً paris=eu-west3,nl=eu-west1,lv=eu-north1b,fi=eu-north3)
 */
interface Flavor { id: string; name: string; vcpus: number; ram: number; disk: number }
interface Image { id: string; name: string; status: string }

/** قیمت‌های اولیه‌ی فروش (تومان). ماهانه = ساعتی × ۷۲۰. بعداً از پنل مدیریت قابل تغییر است. */
const DEFAULT_PRICES: Record<string, number> = { "hostvds-1": 1386, "hostvds-2": 2400, "hostvds-4": 4801 };

const OS_RULES: Array<{ image: string; key: string; name: string }> = [
  { image: "Ubuntu-20.04-amd64", key: "cg_ubuntu_2004", name: "UBUNTU 20" },
  { image: "Ubuntu-22.04-amd64", key: "cg_ubuntu_2204", name: "UBUNTU 22" },
  { image: "Ubuntu-24.04-amd64", key: "cg_ubuntu_2404", name: "UBUNTU 24" },
];

export const CGI_LOCATIONS: Array<{ code: string; key: string; title: string }> = [
  { code: "paris", key: "cgi_paris", title: "🇫🇷 پاریس" },
  { code: "nl", key: "cgi_nl", title: "🇳🇱 هلند" },
  { code: "lv", key: "cgi_lv", title: "🇱🇻 لاتویا" },
  { code: "fi", key: "cgi_fi", title: "🇫🇮 فنلاند" },
];

/** "paris=eu-west3,nl=eu-west1" ← { paris: "eu-west3", nl: "eu-west1" } */
export function parseRegionMap(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(",")) {
    const [k, v] = part.split("=").map((x) => x.trim());
    if (k && v && /^[\w-]+$/.test(v)) out[k.toLowerCase()] = v;
  }
  return out;
}

export interface SeedResult {
  plans: { created: number; activated: number; renamed: number };
  os: { upserted: number; disabled: number };
  locations: { active: string[]; inactive: string[] };
}

export async function seedCatalog(regionMap: Record<string, string> = parseRegionMap(process.env.CGI_REGION_MAP)): Promise<SeedResult> {
  // ── پلن‌ها (فلورها از ریجن پیش‌فرض؛ نام‌ها در همه‌ی ریجن‌ها یکسان است) ──
  const fl = (await call<{ flavors: Array<Record<string, any>> }>("compute", "GET", "/flavors/detail")).json.flavors;
  const flavors: Flavor[] = fl
    .filter((f) => f["os-flavor-access:is_public"] !== false && f.disk > 0)
    .map((f) => ({ id: f.id, name: f.name, vcpus: f.vcpus, ram: f.ram, disk: f.disk }))
    .sort((a, b) => a.ram - b.ram || a.vcpus - b.vcpus);

  let created = 0, activated = 0, renamed = 0;
  for (const f of flavors) {
    // ردیف‌های قدیمی که با شناسه (UUID) ساخته شده بودند ← تبدیل به نام
    const old = await query("UPDATE plans SET dc_ref=$1, name=CASE WHEN name LIKE '%C / %' THEN $1 ELSE name END WHERE datacenter='cgi' AND dc_ref=$2 RETURNING id", [f.name, f.id]);
    renamed += old.length;
    let plan = await queryOne<{ id: number; hourly_price: number }>("SELECT id, hourly_price FROM plans WHERE datacenter='cgi' AND dc_ref=$1", [f.name]);
    if (!plan) {
      const ramGb = Math.max(1, Math.round(f.ram / 1024));
      plan = (await queryOne<{ id: number; hourly_price: number }>(
        `INSERT INTO plans (name, cpu, ram_gb, ram_mb, disk_gb, hourly_price, active, datacenter, dc_ref)
         VALUES ($1,$2,$3,$4,$5,0,FALSE,'cgi',$1) RETURNING id, hourly_price`,
        [f.name, f.vcpus, ramGb, f.ram, f.disk],
      ))!;
      created++;
    }
    const price = DEFAULT_PRICES[f.name];
    if (price && plan.hourly_price === 0) {
      await query("UPDATE plans SET hourly_price=$2, monthly_price=$3, active=TRUE WHERE id=$1", [plan.id, price, price * 720]);
      activated++;
    }
  }

  // ── سیستم‌عامل‌ها ──
  const imgs = (await call<{ images: Image[] }>("image", "GET", "/v2/images", { query: { limit: "200" } })).json.images ?? [];
  let upserted = 0;
  for (const rule of OS_RULES) {
    if (!imgs.some((i) => i.status === "active" && i.name === rule.image)) continue;
    await query(
      `INSERT INTO os_templates (key, name, osid, active, datacenter, dc_ref) VALUES ($1,$2,0,TRUE,'cgi',$3)
       ON CONFLICT (key) DO UPDATE SET dc_ref=EXCLUDED.dc_ref, name=EXCLUDED.name, active=TRUE`,
      [rule.key, rule.name, rule.image],
    );
    upserted++;
  }
  const disabled = (await query("UPDATE os_templates SET active=FALSE WHERE datacenter='cgi' AND key <> ALL($1) AND active RETURNING key", [OS_RULES.map((r) => r.key)])).length;

  // ── لوکیشن‌ها ──
  const active: string[] = [];
  const inactive: string[] = [];
  for (const l of CGI_LOCATIONS) {
    const region = regionMap[l.code] ?? null;
    await query(
      `INSERT INTO locations (key, title, serid, active, datacenter, dc_ref) VALUES ($1,$2,0,$3,'cgi',$4)
       ON CONFLICT (key) DO UPDATE SET title=EXCLUDED.title,
         dc_ref=COALESCE($4, locations.dc_ref),
         active=CASE WHEN COALESCE($4, locations.dc_ref) IS NULL THEN FALSE ELSE locations.active OR $3 END`,
      [l.key, l.title, !!region, region],
    );
    const r = await queryOne<{ active: boolean; dc_ref: string | null }>("SELECT active, dc_ref FROM locations WHERE key=$1", [l.key]);
    (r?.active && r.dc_ref ? active : inactive).push(`${l.title}${r?.dc_ref ? ` (${r.dc_ref})` : ""}`);
  }
  await query("UPDATE locations SET active=FALSE WHERE datacenter='cgi' AND key='cgi1'"); // لوکیشن عمومی نسخه‌ی قبل
  void config;
  return { plans: { created, activated, renamed }, os: { upserted, disabled }, locations: { active, inactive } };
}

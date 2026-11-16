import { config, query, queryOne } from "@/core";
import { call, splitRef } from "./http";

/**
 * کاتالوگ 3HCloud را از خود API می‌خواند و در جدول‌های ربات می‌ریزد (idempotent).
 *  - پلن‌ها: همه‌ی فلورهای عمومی ساخته می‌شوند ولی غیرفعال (بدون قیمت)؛ قیمت از H3C_PRICES ("نام=ساعتی,...") یا پنل ادمین.
 *  - سیستم‌عامل‌ها: Ubuntu 20.04 / 22.04 / 24.04 (اولین ایمیج مطابق هر نسخه)، بقیه غیرفعال.
 *  - لوکیشن‌ها: با H3C_REGION_MAP (پیش‌فرض همه‌ی ۶ ریجن: Miami Dallas SanFrancisco Warsaw Almaty Manila)؛ کد=ریجن یا ریجن/Zone.
 */
export const H3C_LOCATIONS: Array<{ code: string; key: string; title: string }> = [
  { code: "mia", key: "h3c_mia", title: "🇺🇸 میامی" },
  { code: "dfw", key: "h3c_dfw", title: "🇺🇸 دالاس" },
  { code: "sfo", key: "h3c_sfo", title: "🇺🇸 سان‌فرانسیسکو" },
  { code: "waw", key: "h3c_waw", title: "🇵🇱 ورشو" },
  { code: "ala", key: "h3c_ala", title: "🇰🇿 آلماتی" },
  { code: "mnl", key: "h3c_mnl", title: "🇵🇭 مانیل" },
];

const UBUNTU = [
  { re: /ubuntu[^0-9]*20\.04/i, key: "h3_ubuntu_2004", name: "UBUNTU 20" },
  { re: /ubuntu[^0-9]*22\.04/i, key: "h3_ubuntu_2204", name: "UBUNTU 22" },
  { re: /ubuntu[^0-9]*24\.04/i, key: "h3_ubuntu_2404", name: "UBUNTU 24" },
];

/** نام ریجن‌ها همان OS_REGION_NAME فایل RC است */
export const DEFAULT_REGION_MAP = "mia=Miami,dfw=Dallas,sfo=SanFrancisco,waw=Warsaw,ala=Almaty,mnl=Manila";

/** "mia=RegionOne/MIA-1,waw=RegionTwo" ← { mia: "RegionOne/MIA-1", waw: "RegionTwo" } */
export function parseRegionMap(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(",")) {
    const [k, v] = part.split("=").map((x) => x.trim());
    if (k && v && /^[\w.-]+(\/[\w.-]+)?$/.test(v)) out[k.toLowerCase()] = v;
  }
  return out;
}

/** "name=2500,other=4000" ← { name: 2500, other: 4000 } */
export function parsePrices(s: string | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of (s ?? "").split(",")) {
    const i = part.lastIndexOf("=");
    const k = part.slice(0, i).trim();
    const v = Number(part.slice(i + 1));
    if (i > 0 && k && Number.isInteger(v) && v > 0) out[k] = v;
  }
  return out;
}

export interface SeedResult {
  plans: { created: number; activated: number };
  os: { upserted: number; disabled: number };
  locations: { active: string[]; inactive: string[] };
}

export async function seedCatalog(
  regionMap: Record<string, string> = parseRegionMap(process.env.H3C_REGION_MAP || DEFAULT_REGION_MAP),
  prices: Record<string, number> = parsePrices(process.env.H3C_PRICES),
): Promise<SeedResult> {
  const readRegion = config.h3c.region || splitRef(Object.values(regionMap)[0]).region;
  const fl = (await call<{ flavors: Array<Record<string, any>> }>("compute", "GET", "/flavors/detail", { region: readRegion })).json.flavors;
  const flavors = fl
    .filter((f) => f["os-flavor-access:is_public"] !== false)
    .map((f) => ({ name: String(f.name), vcpus: Number(f.vcpus), ram: Number(f.ram), disk: Number(f.disk) }))
    .sort((a, b) => a.ram - b.ram || a.vcpus - b.vcpus);

  let created = 0, activated = 0;
  for (const f of flavors) {
    const diskGb = f.disk > 0 ? f.disk : config.h3c.diskGb;
    let plan = await queryOne<{ id: number; hourly_price: number }>("SELECT id, hourly_price FROM plans WHERE datacenter='h3c' AND dc_ref=$1", [f.name]);
    if (!plan) {
      plan = (await queryOne<{ id: number; hourly_price: number }>(
        `INSERT INTO plans (name, cpu, ram_gb, ram_mb, disk_gb, hourly_price, active, datacenter, dc_ref)
         VALUES ($1,$2,$3,$4,$5,0,FALSE,'h3c',$1) RETURNING id, hourly_price`,
        [f.name, f.vcpus, Math.max(1, Math.round(f.ram / 1024)), f.ram, diskGb],
      ))!;
      created++;
    }
    const price = prices[f.name];
    if (price && plan.hourly_price === 0) {
      await query("UPDATE plans SET hourly_price=$2, monthly_price=$3, active=TRUE WHERE id=$1", [plan.id, price, price * 720]);
      activated++;
    }
  }

  const imgs = ((await call<{ images: Array<{ name: string; status: string }> }>("image", "GET", "/v2/images", { region: readRegion, query: { limit: "200" } })).json.images ?? []).filter((i) => i.status === "active");
  let upserted = 0;
  const keep: string[] = [];
  for (const rule of UBUNTU) {
    const img = imgs.find((i) => rule.re.test(i.name) && !/prebuilt|docker|panel/i.test(i.name));
    if (!img) continue;
    keep.push(rule.key);
    await query(
      `INSERT INTO os_templates (key, name, osid, active, datacenter, dc_ref) VALUES ($1,$2,0,TRUE,'h3c',$3)
       ON CONFLICT (key) DO UPDATE SET dc_ref=EXCLUDED.dc_ref, name=EXCLUDED.name, active=TRUE`,
      [rule.key, rule.name, img.name],
    );
    upserted++;
  }
  const disabled = (await query("UPDATE os_templates SET active=FALSE WHERE datacenter='h3c' AND key <> ALL($1) AND active RETURNING key", [keep])).length;

  const active: string[] = [];
  const inactive: string[] = [];
  for (const l of H3C_LOCATIONS) {
    const ref = regionMap[l.code] ?? null;
    await query(
      `INSERT INTO locations (key, title, serid, active, datacenter, dc_ref) VALUES ($1,$2,0,$3,'h3c',$4)
       ON CONFLICT (key) DO UPDATE SET title=EXCLUDED.title,
         dc_ref=COALESCE($4, locations.dc_ref),
         active=CASE WHEN COALESCE($4, locations.dc_ref) IS NULL THEN FALSE ELSE locations.active OR $3 END`,
      [l.key, l.title, !!ref, ref],
    );
    const r = await queryOne<{ active: boolean; dc_ref: string | null }>("SELECT active, dc_ref FROM locations WHERE key=$1", [l.key]);
    (r?.active && r.dc_ref ? active : inactive).push(`${l.title}${r?.dc_ref ? ` (${r.dc_ref})` : ""}`);
  }
  return { plans: { created, activated }, os: { upserted, disabled }, locations: { active, inactive } };
}

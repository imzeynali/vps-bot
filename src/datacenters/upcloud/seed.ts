import { config, query, queryOne } from "@/core";
import { call, listIn } from "./http";

/**
 * کاتالوگ UpCloud را از API می‌خواند و در جدول‌های ربات می‌ریزد (idempotent).
 *  - پلن‌ها: GET /plan (GPU و custom حذف)؛ غیرفعال و بدون قیمت، تا قیمت (تومان) از UPCLOUD_PRICES «نام=قیمت‌ساعتی,...» یا پنل ادمین.
 *  - سیستم‌عامل‌ها: GET /storage/template ← Ubuntu 20.04 / 22.04 / 24.04.
 *  - لوکیشن‌ها: زون‌های UPCLOUD_ZONES که در GET /zone هستند (public).
 */
const FLAG: Record<string, string> = { fi: "🇫🇮", de: "🇩🇪", nl: "🇳🇱", uk: "🇬🇧", us: "🇺🇸", sg: "🇸🇬", pl: "🇵🇱", es: "🇪🇸", au: "🇦🇺", se: "🇸🇪", dk: "🇩🇰", no: "🇳🇴", fr: "🇫🇷" };
const UBUNTU = [
  { re: /ubuntu[^0-9]*20\.04/i, key: "up_ubuntu_2004", name: "UBUNTU 20" },
  { re: /ubuntu[^0-9]*22\.04/i, key: "up_ubuntu_2204", name: "UBUNTU 22" },
  { re: /ubuntu[^0-9]*24\.04/i, key: "up_ubuntu_2404", name: "UBUNTU 24" },
];

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

type Json = Record<string, any>;
export interface PlanInfo { name: string; cores: number; ramMb: number; diskGb: number; tier: string }
/** پلن‌های عادی از GET /plan (مقادیر عددی در UpCloud رشته هستند) */
export function parsePlans(j: Json): PlanInfo[] {
  return listIn(j, "plans", "plan")
    .filter((p) => p.name && !/^gpu|custom/i.test(String(p.name)))
    .map((p) => ({ name: String(p.name), cores: Number(p.core_number) || 0, ramMb: Number(p.memory_amount) || 0, diskGb: Number(p.storage_size) || 0, tier: String(p.storage_tier ?? "") }))
    .filter((p) => p.cores > 0 && p.ramMb > 0 && p.diskGb > 0);
}

export interface ZoneInfo { id: string; description: string }
export function parseZones(j: Json): ZoneInfo[] {
  return listIn(j, "zones", "zone").filter((z) => z.id && z.public !== "no").map((z) => ({ id: String(z.id), description: String(z.description ?? z.id) }));
}

export interface SeedResult {
  plans: { created: number; activated: number; list: PlanInfo[] };
  os: { upserted: number; disabled: number };
  locations: { active: string[]; missing: string[] };
}

export async function seedCatalog(prices: Record<string, number> = parsePrices(process.env.UPCLOUD_PRICES)): Promise<SeedResult> {
  const plans = parsePlans(await call("GET", "/plan"));
  let created = 0, activated = 0;
  for (const p of plans) {
    let row = await queryOne<{ id: number; hourly_price: number }>("SELECT id, hourly_price FROM plans WHERE datacenter='upcloud' AND dc_ref=$1", [p.name]);
    if (!row) {
      row = (await queryOne<{ id: number; hourly_price: number }>(
        `INSERT INTO plans (name, cpu, ram_gb, ram_mb, disk_gb, hourly_price, active, datacenter, dc_ref)
         VALUES ($1,$2,$3,$4,$5,0,FALSE,'upcloud',$1) RETURNING id, hourly_price`,
        [p.name, p.cores, Math.max(1, Math.round(p.ramMb / 1024)), p.ramMb, p.diskGb],
      ))!;
      created++;
    }
    const price = prices[p.name];
    if (price && row.hourly_price === 0) {
      await query("UPDATE plans SET hourly_price=$2, monthly_price=$3, active=TRUE WHERE id=$1", [row.id, price, price * 720]);
      activated++;
    }
  }

  const templates = listIn(await call("GET", "/storage/template"), "storages", "storage");
  const keep: string[] = [];
  let upserted = 0;
  for (const rule of UBUNTU) {
    const t = templates.find((x) => rule.re.test(String(x.title ?? "")) && !/desktop|gpu|minimal/i.test(String(x.title)));
    if (!t?.uuid) continue;
    keep.push(rule.key);
    await query(
      `INSERT INTO os_templates (key, name, osid, active, datacenter, dc_ref) VALUES ($1,$2,0,TRUE,'upcloud',$3)
       ON CONFLICT (key) DO UPDATE SET dc_ref=EXCLUDED.dc_ref, name=EXCLUDED.name, active=TRUE`,
      [rule.key, rule.name, String(t.uuid)],
    );
    upserted++;
  }
  const disabled = (await query("UPDATE os_templates SET active=FALSE WHERE datacenter='upcloud' AND key <> ALL($1) AND active RETURNING key", [keep])).length;

  const zones = parseZones(await call("GET", "/zone"));
  const active: string[] = [];
  const missing: string[] = [];
  for (const id of config.upcloud.zones) {
    const z = zones.find((x) => x.id === id);
    if (!z) { missing.push(id); continue; }
    const title = `${FLAG[id.slice(0, 2)] ?? "🌍"} ${z.description}`;
    await query(
      `INSERT INTO locations (key, title, serid, active, datacenter, dc_ref) VALUES ($1,$2,0,TRUE,'upcloud',$3)
       ON CONFLICT (key) DO UPDATE SET title=EXCLUDED.title, dc_ref=EXCLUDED.dc_ref`,
      [`up_${id}`, title, id],
    );
    active.push(`${title} (${id})`);
  }
  return { plans: { created, activated, list: plans }, os: { upserted, disabled }, locations: { active, missing } };
}

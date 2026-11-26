import { config, query, queryOne } from "@/core";
import { call, listOf, projectUuid } from "./http";

/**
 * کاتالوگ Virtua را از API می‌خواند و در جدول‌های ربات می‌ریزد (idempotent).
 *  - پلن‌ها: offerهای لینوکس (ویندوز حذف می‌شود)؛ غیرفعال و بدون قیمت، تا قیمت (تومان) از VIRTUA_PRICES «نام=قیمت‌ساعتی,...» یا پنل ادمین.
 *  - سیستم‌عامل‌ها: Ubuntu 20.04 / 22.04 / 24.04.
 *  - لوکیشن: «🇫🇷 پاریس (Virtua)» با dc_ref = UUID پروژه.
 */
const UBUNTU = [
  { re: /ubuntu[^0-9]*20\.04/i, key: "vt_ubuntu_2004", name: "UBUNTU 20" },
  { re: /ubuntu[^0-9]*22\.04/i, key: "vt_ubuntu_2204", name: "UBUNTU 22" },
  { re: /ubuntu[^0-9]*24\.04/i, key: "vt_ubuntu_2404", name: "UBUNTU 24" },
];
export const VIRTUA_LOCATION = { key: "virtua_fr", title: "🇫🇷 پاریس (Virtua)" };

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
const num = (...v: unknown[]) => {
  for (const x of v) if (x != null && x !== "" && Number.isFinite(Number(x))) return Number(x);
  return 0;
};
export interface OfferInfo { uuid: string; name: string; vcpus: number; ramMb: number; diskGb: number; priceHourEur: string | null }
/** offerهای لینوکسی از پاسخ GET /cloud/offers (نام فیلدها تحمل‌پذیر است) */
export function parseOffers(j: Json): OfferInfo[] {
  return listOf(j, ["offers", "cloud_offers"])
    .filter((o) => o.uuid && !/win/i.test(`${o.category ?? ""} ${o.name ?? ""} ${o.uuid}`))
    .map((o) => ({
      uuid: String(o.uuid),
      name: String(o.name ?? o.uuid),
      vcpus: num(o.vcpus, o.cpu, o.cores, /vcs-(\d+)/i.exec(String(o.name))?.[1]),
      ramMb: num(o.memory_size, o.ram, o.memory),
      diskGb: num(o.root_space, o.disk, o.storage),
      priceHourEur: o.price_hour != null ? String(o.price_hour) : null,
    }));
}

export interface SeedResult {
  plans: { created: number; activated: number; list: OfferInfo[] };
  os: { upserted: number; disabled: number };
  location: string;
}

export async function seedCatalog(prices: Record<string, number> = parsePrices(process.env.VIRTUA_PRICES)): Promise<SeedResult> {
  const offers = parseOffers(await call("GET", "/cloud/offers"));
  let created = 0, activated = 0;
  for (const o of offers) {
    let plan = await queryOne<{ id: number; hourly_price: number }>("SELECT id, hourly_price FROM plans WHERE datacenter='virtua' AND dc_ref=$1", [o.uuid]);
    if (!plan) {
      plan = (await queryOne<{ id: number; hourly_price: number }>(
        `INSERT INTO plans (name, cpu, ram_gb, ram_mb, disk_gb, hourly_price, active, datacenter, dc_ref)
         VALUES ($1,$2,$3,$4,$5,0,FALSE,'virtua',$6) RETURNING id, hourly_price`,
        [o.name, o.vcpus, Math.max(1, Math.round(o.ramMb / 1024)), o.ramMb, o.diskGb, o.uuid],
      ))!;
      created++;
    }
    const price = prices[o.name];
    if (price && plan.hourly_price === 0) {
      await query("UPDATE plans SET hourly_price=$2, monthly_price=$3, active=TRUE WHERE id=$1", [plan.id, price, price * 720]);
      activated++;
    }
  }

  const systems = listOf(await call("GET", "/cloud/systems"), ["systems", "cloud_systems"]);
  const keep: string[] = [];
  let upserted = 0;
  for (const rule of UBUNTU) {
    const sys = systems.find((x) => rule.re.test(String(x.name ?? "")) && !/win/i.test(String(x.uuid)) && !/32 ?bits/i.test(String(x.name)));
    if (!sys) continue;
    keep.push(rule.key);
    await query(
      `INSERT INTO os_templates (key, name, osid, active, datacenter, dc_ref) VALUES ($1,$2,0,TRUE,'virtua',$3)
       ON CONFLICT (key) DO UPDATE SET dc_ref=EXCLUDED.dc_ref, name=EXCLUDED.name, active=TRUE`,
      [rule.key, rule.name, String(sys.uuid)],
    );
    upserted++;
  }
  const disabled = (await query("UPDATE os_templates SET active=FALSE WHERE datacenter='virtua' AND key <> ALL($1) AND active RETURNING key", [keep])).length;

  const project = await projectUuid();
  await query(
    `INSERT INTO locations (key, title, serid, active, datacenter, dc_ref) VALUES ($1,$2,0,TRUE,'virtua',$3)
     ON CONFLICT (key) DO UPDATE SET title=EXCLUDED.title, dc_ref=EXCLUDED.dc_ref`,
    [VIRTUA_LOCATION.key, VIRTUA_LOCATION.title, project],
  );
  void config;
  return { plans: { created, activated, list: offers }, os: { upserted, disabled }, location: `${VIRTUA_LOCATION.title} (${project})` };
}

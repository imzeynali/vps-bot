import { config, query, queryOne } from "@/core";
import { call } from "./http";

/**
 * کاتالوگ CGI را از خود API می‌خواند و در جدول‌های ربات می‌ریزد (idempotent؛ چندبار اجرا امن است):
 *  - پلن‌ها: از فلورها، با قیمت ۰ و غیرفعال تا ادمین قیمت بدهد (بدون قیمت‌گذاری دستی چیزی فروخته نمی‌شود)
 *  - سیستم‌عامل‌ها: فقط توزیع‌های اصلی (Ubuntu/Debian/AlmaLinux/Rocky)، نه ایمیج‌های آماده‌ی برنامه
 *  - لوکیشن: یک لوکیشن «CGI» برای ریجن تنظیم‌شده
 */
interface Flavor { id: string; name: string; vcpus: number; ram: number; disk: number }
interface Image { id: string; name: string; status: string }

const OS_RULES: Array<{ re: RegExp; key: (m: RegExpMatchArray) => string; name: (m: RegExpMatchArray) => string }> = [
  { re: /^Ubuntu-(20\.04|22\.04|24\.04)-amd64$/, key: (m) => `cg_ubuntu_${m[1].replace(".", "")}`, name: (m) => `Ubuntu ${m[1]}` },
  { re: /^Debian-(11|12|13)-amd64$/, key: (m) => `cg_debian_${m[1]}`, name: (m) => `Debian ${m[1]}` },
  { re: /^AlmaLinux-(8|9)-amd64$/, key: (m) => `cg_alma_${m[1]}`, name: (m) => `AlmaLinux ${m[1]}` },
  { re: /^RockyLinux-(8|9)-amd64$/, key: (m) => `cg_rocky_${m[1]}`, name: (m) => `Rocky Linux ${m[1]}` },
];

export interface SeedResult {
  plans: { created: number; existing: number };
  os: { upserted: number };
  location: string;
}

export async function seedCatalog(): Promise<SeedResult> {
  const fl = (await call<{ flavors: Array<Record<string, any>> }>("compute", "GET", "/flavors/detail")).json.flavors;
  const flavors: Flavor[] = fl
    .filter((f) => f["os-flavor-access:is_public"] !== false && f.disk > 0)
    .map((f) => ({ id: f.id, name: f.name, vcpus: f.vcpus, ram: f.ram, disk: f.disk }))
    .sort((a, b) => a.ram - b.ram || a.vcpus - b.vcpus);

  let created = 0;
  let existing = 0;
  for (const f of flavors) {
    if (await queryOne("SELECT 1 FROM plans WHERE datacenter='cgi' AND dc_ref=$1", [f.id])) {
      existing++;
      continue;
    }
    const ramGb = Math.max(1, Math.round(f.ram / 1024));
    const name = `${f.vcpus}C / ${ramGb}GB / ${f.disk}G${f.name.startsWith("highload") ? " (HL)" : ""}`;
    await query(
      `INSERT INTO plans (name, cpu, ram_gb, ram_mb, disk_gb, hourly_price, active, datacenter, dc_ref)
       VALUES ($1,$2,$3,$4,$5,0,FALSE,'cgi',$6)`,
      [name, f.vcpus, ramGb, f.ram, f.disk, f.id],
    );
    created++;
  }

  const imgs = (await call<{ images: Image[] }>("image", "GET", "/v2/images", { query: { limit: "200" } })).json.images ?? [];
  let upserted = 0;
  for (const img of imgs) {
    if (img.status !== "active") continue;
    for (const rule of OS_RULES) {
      const m = img.name.match(rule.re);
      if (!m) continue;
      await query(
        `INSERT INTO os_templates (key, name, osid, active, datacenter, dc_ref) VALUES ($1,$2,0,TRUE,'cgi',$3)
         ON CONFLICT (key) DO UPDATE SET dc_ref=EXCLUDED.dc_ref, name=EXCLUDED.name`,
        [rule.key(m), rule.name(m), img.id],
      );
      upserted++;
    }
  }

  await query(
    `INSERT INTO locations (key, title, serid, active, datacenter, dc_ref) VALUES ('cgi1','🌍 CGI',0,TRUE,'cgi',$1)
     ON CONFLICT (key) DO UPDATE SET dc_ref=EXCLUDED.dc_ref`,
    [config.cgi.region],
  );
  return { plans: { created, existing }, os: { upserted }, location: "cgi1" };
}

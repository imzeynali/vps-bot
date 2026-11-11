export {};
/**
 * ریجن‌های حساب CGI را با مشخصات و حدس کشور نشان می‌دهد تا نگاشت لوکیشن‌ها (CGI_REGION_MAP) را بنویسید.
 * کشور از روی IP اولین رنج شبکه‌ی هر ریجن با سرویس ip-api.com تعیین می‌شود (فقط حدس؛ ممکن است دقیق نباشد).
 *
 * اجرا:
 *   npm run cgi:regions                      ← نمایش لیست
 *   npm run cgi:regions -- --out /tmp/x      ← (برای اینستالر) دو فایل می‌نویسد:
 *        /tmp/x/regions.tsv   region ⇥ شبکه ⇥ فلور ⇥ پلن‌های hostvds-1/2/4 (1/0) ⇥ سهمیه‌ی استفاده‌شده ⇥ سقف ⇥ کشور ⇥ شهر
 *        /tmp/x/suggest.tsv   کد لوکیشن ⇥ ریجن‌های هم‌کشور (به ترتیب پیشنهاد، با کاما)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** کشورِ هر لوکیشن منو (کدها با CGI_LOCATIONS در src/datacenters/cgi/seed.ts یکی است) */
const COUNTRY_OF: Record<string, string> = { paris: "France", nl: "Netherlands", lv: "Latvia", fi: "Finland" };
const NEED_PLANS = ["hostvds-1", "hostvds-2", "hostvds-4"];

/** ip-api نام کشور را گاهی با «The» برمی‌گرداند (The Netherlands)؛ برای مقایسه یکسان‌سازی می‌کنیم */
const norm = (c: string) => c.trim().toLowerCase().replace(/^the\s+/, "");

interface Row { region: string; nets: number; flavors: number; plansOk: boolean; used: number; max: number; country: string; city: string; error?: string }

async function geo(ip: string): Promise<{ country: string; city: string } | null> {
  try {
    const j = (await (await fetch(`http://ip-api.com/json/${ip}?fields=status,country,city`, { signal: AbortSignal.timeout(6000) })).json()) as { status?: string; country?: string; city?: string };
    return j.status === "success" ? { country: j.country ?? "?", city: j.city ?? "?" } : null;
  } catch {
    return null; // بدون اینترنت / محدودیت نرخ
  }
}

async function main() {
  const oi = process.argv.indexOf("--out");
  const outDir = oi > 0 ? process.argv[oi + 1] : "";
  const { catalogRegions } = await import("../src/datacenters/cgi/http");
  const OS = await import("../src/datacenters/cgi/openstack");
  const regions = await catalogRegions();
  console.log(`${regions.length} ریجن در کاتالوگ:\n`);

  const rows: Row[] = [];
  for (const region of regions) {
    const row: Row = { region, nets: 0, flavors: 0, plansOk: false, used: 0, max: 0, country: "?", city: "?" };
    // بعضی ریجن‌ها گاهی 502 می‌دهند؛ یک‌بار دیگر تلاش می‌کنیم
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const [nets, flv, l] = await Promise.all([OS.networksWithV4(region), OS.listFlavors(region), OS.limits(region)]);
        row.nets = nets.length;
        row.flavors = flv.length;
        row.plansOk = NEED_PLANS.every((n) => flv.some((f) => f.name === n));
        row.used = l.instances[0];
        row.max = l.instances[1];
        const sample = nets[0]?.cidr?.split("/")[0]?.replace(/\.0$/, ".10");
        if (sample) {
          const g = await geo(sample);
          if (g) { row.country = g.country; row.city = g.city; }
        }
        row.error = undefined;
        break;
      } catch (e) {
        row.error = e instanceof Error ? e.message.slice(0, 80) : String(e);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    rows.push(row);
    console.log(
      row.error
        ? `• ${region.padEnd(13)} ❌ ${row.error}`
        : `• ${region.padEnd(13)} ${String(row.nets).padStart(2)} شبکه  ${String(row.flavors).padStart(2)} فلور  سرور ${row.used}/${row.max}  پلن‌های hostvds-1/2/4: ${row.plansOk ? "✔" : "✘"}  ← ${row.country} / ${row.city}`,
    );
    await new Promise((r) => setTimeout(r, 1500)); // محدودیت ip-api (۴۵ درخواست در دقیقه)
  }

  // پیشنهاد نگاشت: ریجن‌های هم‌کشور، اول آن‌هایی که هر سه پلن را دارند، بعد بیشترین شبکه
  const suggest: Record<string, string[]> = {};
  for (const [code, country] of Object.entries(COUNTRY_OF)) {
    suggest[code] = rows
      .filter((r) => !r.error && norm(r.country) === norm(country))
      .sort((a, b) => Number(b.plansOk) - Number(a.plansOk) || b.nets - a.nets || a.region.localeCompare(b.region))
      .map((r) => r.region);
  }
  const ok = rows.filter((r) => !r.error);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, "regions.tsv"), ok.map((r) => [r.region, r.nets, r.flavors, r.plansOk ? 1 : 0, r.used, r.max, r.country, r.city].join("\t")).join("\n") + "\n");
    writeFileSync(join(outDir, "suggest.tsv"), Object.entries(suggest).map(([k, v]) => `${k}\t${v.join(",")}`).join("\n") + "\n");
  } else {
    const ex = Object.entries(suggest).filter(([, v]) => v[0]).map(([k, v]) => `${k}=${v[0]}`).join(",");
    console.log(`\nپیشنهاد خودکار (اولین ریجن هم‌کشور؛ حدس است): CGI_REGION_MAP=${ex}`);
    console.log("کشورهای چندریجنی را خودتان انتخاب کنید و در .env.local بگذارید، یا با «vpsbot cgi» از داخل منو انجام دهید.");
  }
  if (ok.length === 0) throw new Error("هیچ ریجنی قابل خواندن نبود (کلیدهای CGI یا دسترسی شبکه را بررسی کنید)");
}
main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});

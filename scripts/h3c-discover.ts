export {};
/**
 * ابزار کشف 3HCloud: با کاربر API وصل می‌شود و آنچه برای تنظیم لازم است را نشان می‌دهد
 * (ریجن‌ها، فلورها، ایمیج‌های Ubuntu، انواع دیسک، شبکه‌ها با نشانه‌ی external، گروه‌های امنیتی، سهمیه).
 * اجرا: npm run h3c:discover   (قبلش H3C_* در .env.local باشد)
 */
async function main() {
  const { isConfigured, KNOWN_REGIONS, authUrlFor, call, catalog } = await import("../src/datacenters/h3c/http");
  const OS = await import("../src/datacenters/h3c/openstack");
  if (!isConfigured()) throw new Error("H3C_USERNAME / H3C_PASSWORD / H3C_PROJECT را در .env.local بگذارید");
  // هر ریجن Keystone جدا دارد؛ ریجن‌های شناخته‌شده + ریجن‌های نگاشت‌شده بررسی می‌شوند
  const mapped = (process.env.H3C_REGION_MAP ?? "").split(",").map((x) => x.split("=")[1]?.split("/")[0]?.trim()).filter(Boolean) as string[];
  const regions = [...new Set([...KNOWN_REGIONS, ...mapped])];
  for (const region of regions) {
    console.log(`━━ ریجن «${region}» (${authUrlFor(region)}) ━━`);
    const safe = async <T>(label: string, f: () => Promise<T>) => {
      try {
        return await f();
      } catch (e) {
        console.log(`  ${label}: ❌ ${e instanceof Error ? e.message : e}`);
        return null;
      }
    };
    const cat = await safe("کاتالوگ", () => catalog(region));
    if (cat) {
      console.log("  آدرس سرویس‌ها: " + cat.map((c) => `${c.type}=${c.endpoints.filter((e) => e.interface === "public").map((e) => { try { return new URL(e.url).host; } catch { return e.url; } }).join("|")}`).join("  "));
    } else {
      console.log("");
      continue; // احراز هویت این ریجن ممکن نیست؛ بقیه‌ی بررسی‌ها بی‌معناست
    }
    const l = await safe("سهمیه", () => OS.limits(region));
    if (l) console.log(`  سهمیه: سرور ${l.instances[0]}/${l.instances[1]} | هسته ${l.cores[0]}/${l.cores[1]} | رم ${Math.round(l.ramMb[0] / 1024)}/${Math.round(l.ramMb[1] / 1024)}GB`);
    const fl = await safe("فلورها", () => OS.listFlavors(region));
    if (fl) console.log(`  فلورها (${fl.length}): ` + fl.slice(0, 12).map((f) => `${f.name}[${f.vcpus}c/${Math.round(f.ram / 1024)}G/disk${f.disk}]`).join("  ") + (fl.length > 12 ? " …" : "") + (fl.some((f) => f.disk === 0) ? "\n   ℹ️ فلور با disk=0 یعنی دیسک سیستم از روی volume ساخته می‌شود (H3C_DISK_GB / H3C_VOLUME_TYPE)" : ""));
    const im = await safe("ایمیج‌ها", () => OS.listImages(region));
    if (im) console.log(`  ایمیج‌های Ubuntu: ${im.filter((i) => /ubuntu/i.test(i.name)).map((i) => i.name).join(" | ") || "—"}`);
    const vt = await safe("انواع دیسک", () => OS.volumeTypes(region));
    if (vt) console.log(`  انواع دیسک (H3C_VOLUME_TYPE): ${vt.join(", ") || "—"}`);
    const nets = await safe("شبکه‌ها", () => OS.allNetworksWithV4(region));
    if (nets) {
      console.log(`  شبکه‌های دارای IPv4:`);
      for (const n of nets) console.log(`    ${n.external ? "🌐 external" : "🔒 internal"}  ${n.name}  ${n.cidr}`);
      if (!nets.some((n) => n.external)) console.log("   ⚠️ شبکه‌ی external دیده نشد ← نام شبکه‌ی عمومی را در H3C_NETWORK بگذارید");
    }
    const sg = await safe("گروه امنیتی", () => call<{ security_groups: Array<{ name: string }> }>("network", "GET", "/v2.0/security-groups", { region }));
    if (sg) console.log(`  گروه‌های امنیتی (H3C_SECURITY_GROUP): ${sg.json.security_groups.map((s) => s.name).join(", ") || "—"}`);
    console.log("");
  }
  console.log("بعد: H3C_REGION_MAP (پیش‌فرض: mia=Miami,dfw=Dallas,sfo=SanFrancisco,waw=Warsaw,ala=Almaty,mnl=Manila) و سپس npm run h3c:seed");
}
main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});

export {};
/**
 * ریجن‌های حساب CGI را با مشخصات و حدس کشور نشان می‌دهد تا نگاشت لوکیشن‌ها (CGI_REGION_MAP) را بنویسید.
 * کشور از روی IP اولین رنج شبکه‌ی هر ریجن با سرویس ip-api.com (فقط حدس؛ ممکن است دقیق نباشد) تعیین می‌شود.
 * اجرا: npm run cgi:regions
 */
async function main() {
  const { catalogRegions } = await import("../src/datacenters/cgi/http");
  const OS = await import("../src/datacenters/cgi/openstack");
  const regions = await catalogRegions();
  console.log(`${regions.length} ریجن در کاتالوگ:\n`);
  for (const region of regions) {
    try {
      const [nets, flv, l] = await Promise.all([OS.networksWithV4(region), OS.listFlavors(region), OS.limits(region)]);
      const sample = nets[0]?.cidr?.split("/")[0]?.replace(/\.0$/, ".10");
      let geo = "?";
      if (sample) {
        try {
          const j = (await (await fetch(`http://ip-api.com/json/${sample}?fields=status,country,city`, { signal: AbortSignal.timeout(6000) })).json()) as { status?: string; country?: string; city?: string };
          if (j.status === "success") geo = `${j.country} / ${j.city}`;
        } catch { /* بدون اینترنت/محدودیت */ }
      }
      console.log(`• ${region.padEnd(13)} ${String(nets.length).padStart(2)} شبکه  ${String(flv.length).padStart(2)} فلور  سرور ${l.instances[0]}/${l.instances[1]}  نمونه IP: ${nets[0]?.cidr ?? "-"}  ← ${geo}`);
    } catch (e) {
      console.log(`• ${region.padEnd(13)} ❌ ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
    await new Promise((r) => setTimeout(r, 1500)); // محدودیت ip-api (۴۵ درخواست در دقیقه)
  }
  console.log("\nمثال نگاشت: CGI_REGION_MAP=paris=eu-west3,nl=eu-west1,lv=eu-north1b,fi=eu-north3");
}
main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});

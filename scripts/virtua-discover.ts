export {};
/**
 * ابزار کشف Virtua.Cloud: با کلید API وصل می‌شود و آنچه برای تنظیم لازم است را نشان می‌دهد
 * (حساب، سقف سرور، پروژه‌ها، offerهای لینوکس، سیستم‌عامل‌ها، و ساختار خام پاسخ‌ها برای تأیید نام فیلدها).
 * اجرا: npm run virtua:discover     (قبلش VIRTUA_API_KEY در .env.local باشد)
 */
async function main() {
  const H = await import("../src/datacenters/virtua/http");
  const S = await import("../src/datacenters/virtua/seed");
  if (!H.isConfigured()) throw new Error("VIRTUA_API_KEY را در .env.local بگذارید");
  const safe = async <T>(label: string, f: () => Promise<T>) => {
    try { return await f(); } catch (e) { console.log(`  ${label}: ❌ ${e instanceof Error ? e.message : e}`); return null; }
  };
  const acc = await safe("حساب", () => H.call("GET", "/account"));
  if (!acc) process.exit(1);
  console.log(`✅ اتصال برقرار شد. موجودی: ${acc.balance} ${acc.currency} | سقف سرور: ${acc.cloud_servers_limit} | منطقه‌ی زمانی: ${acc.timezone}`);
  const lim = await safe("سهمیه", () => H.limits());
  if (lim) console.log(`  سرورها: ${lim.servers[0]}/${lim.servers[1]}` + (lim.servers[1] <= 10 ? "  ⚠️ سقف کم است؛ قبل از فروش از Virtua افزایش بخواهید" : ""));

  const proj = await safe("پروژه‌ها", () => H.call("GET", "/project"));
  if (proj) {
    const list = H.listOf(proj, ["projects"]);
    console.log(`\nپروژه‌ها (VIRTUA_PROJECT): ${list.map((p) => `${p.uuid}${p.name ? ` «${p.name}»` : ""}`).join(" | ") || "—"}`);
    console.log("  ساختار خام اولین مورد:", JSON.stringify(list[0] ?? proj).slice(0, 300));
  }
  const offers = await safe("offerها", () => H.call("GET", "/cloud/offers"));
  if (offers) {
    const parsed = S.parseOffers(offers);
    console.log(`\nofferهای لینوکس (${parsed.length}) — قیمت تمام‌شده ساعتی به یورو:`);
    for (const o of parsed.slice(0, 25)) console.log(`  ${o.name.padEnd(14)} ${o.uuid.padEnd(26)} ${o.vcpus}c / ${Math.round(o.ramMb / 1024)}G / ${o.diskGb}GB   €${o.priceHourEur ?? "?"}/h`);
    if (parsed.some((o) => !o.ramMb || !o.vcpus)) console.log("  ⚠️ مشخصات بعضی offerها از پاسخ خوانده نشد؛ ساختار خام زیر را بفرستید");
    console.log("  ساختار خام اولین مورد:", JSON.stringify(H.listOf(offers, ["offers", "cloud_offers"])[0] ?? offers).slice(0, 400));
  }
  const systems = await safe("سیستم‌عامل‌ها", () => H.call("GET", "/cloud/systems"));
  if (systems) {
    const list = H.listOf(systems, ["systems", "cloud_systems"]);
    console.log(`\nسیستم‌عامل‌های Ubuntu: ${list.filter((x) => /ubuntu/i.test(String(x.name))).map((x) => `${x.name} [${x.uuid}]`).join(" | ") || "—"}`);
  }
  const servers = await safe("سرورها", () => H.listServers());
  if (servers && servers[0]) {
    console.log("\nساختار خام جزئیات یک سرور موجود (برای تعیین فیلد IP و پسورد):");
    console.log(JSON.stringify(servers[0].raw).slice(0, 700));
    console.log(`  IP شناسایی‌شده: ${H.ipv4Of(servers[0].raw) ?? "— (نشد)"} | پسورد: ${H.passwordOf(servers[0].raw) ? "فیلد پیدا شد" : "— (فیلدی شبیه password نیست)"}`);
  }
  console.log("\nبعد: npm run virtua:seed   و برای تست واقعی:  npm run virtua:smoke -- create");
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });

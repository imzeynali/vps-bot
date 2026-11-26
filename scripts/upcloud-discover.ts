export {};
/**
 * ابزار کشف UpCloud: با توکن وصل می‌شود و آنچه برای تنظیم لازم است را نشان می‌دهد
 * (حساب و اعتبار، زون‌ها، پلن‌ها، تمپلیت‌های Ubuntu، و ساختار خام پاسخ‌ها برای تأیید نام فیلدها).
 * اجرا: npm run upcloud:discover     (قبلش UPCLOUD_TOKEN در .env.local باشد)
 */
async function main() {
  const H = await import("../src/datacenters/upcloud/http");
  const S = await import("../src/datacenters/upcloud/seed");
  const { config } = await import("../src/core");
  if (!H.isConfigured()) throw new Error("UPCLOUD_TOKEN را در .env.local بگذارید");
  const safe = async <T>(label: string, f: () => Promise<T>) => {
    try { return await f(); } catch (e) { console.log(`  ${label}: ❌ ${e instanceof Error ? e.message : e}`); return null; }
  };
  const acc = await safe("حساب", () => H.account());
  if (!acc) process.exit(1);
  console.log(`✅ اتصال برقرار شد. حساب: ${acc.username} | اعتبار: ${acc.credits != null ? (acc.credits / 100).toFixed(2) : "?"} (واحد پول حساب)`);
  const limits = acc.raw.resource_limits as Record<string, number> | undefined;
  if (limits) console.log(`  سقف منابع: ${Object.entries(limits).filter(([k]) => /server|core|memory|public_ipv4/i.test(k)).map(([k, v]) => `${k}=${v}`).join(" ") || "—"}`);

  const zones = await safe("زون‌ها", async () => S.parseZones(await H.call("GET", "/zone")));
  if (zones) {
    console.log(`\nزون‌ها (${zones.length}): ` + zones.map((z) => `${z.id}${config.upcloud.zones.includes(z.id) ? "✔" : ""}`).join("  "));
    console.log(`  (✔ = در UPCLOUD_ZONES؛ لوکیشن ساخته می‌شود)  گم‌شده از حساب: ${config.upcloud.zones.filter((id) => !zones.some((z) => z.id === id)).join(", ") || "—"}`);
  }
  const plan = await safe("پلن‌ها", () => H.call("GET", "/plan"));
  if (plan) {
    const plans = S.parsePlans(plan);
    console.log(`\nپلن‌ها (${plans.length}):`);
    for (const p of plans.slice(0, 30)) console.log(`  ${p.name.padEnd(22)} ${p.cores}c / ${Math.round(p.ramMb / 1024)}G / ${p.diskGb}GB ${p.tier}`);
    console.log("  ساختار خام اولین مورد:", JSON.stringify(H.listIn(plan, "plans", "plan")[0] ?? plan).slice(0, 300));
  }
  const tpl = await safe("تمپلیت‌ها", () => H.call("GET", "/storage/template"));
  if (tpl) {
    const list = H.listIn(tpl, "storages", "storage");
    console.log(`\nتمپلیت‌های Ubuntu: ${list.filter((x) => /ubuntu/i.test(String(x.title))).map((x) => `${x.title} [${x.uuid}]`).join(" | ") || "—"}`);
    console.log("  ساختار خام اولین مورد:", JSON.stringify(list[0] ?? tpl).slice(0, 300));
  }
  const servers = await safe("سرورها", () => H.listServers());
  if (servers) {
    console.log(`\nسرورهای حساب: ${servers.length}`);
    if (servers[0]) {
      const ip = await safe("شبکه", () => H.networkingIp(servers[0]!.uuid));
      console.log("  ساختار خام جزئیات یک سرور (برای تأیید فیلدها):", JSON.stringify(servers[0].raw).slice(0, 400));
      console.log(`  IP عمومی شناسایی‌شده: ${ip ?? "—"}`);
    }
  }
  console.log(`\nحالت پسورد: ${config.upcloud.passwordMode} (UPCLOUD_PASSWORD_MODE=userdata|api)`);
  console.log("بعد: npm run upcloud:seed   و برای تست واقعی:  npm run upcloud:smoke -- create");
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });

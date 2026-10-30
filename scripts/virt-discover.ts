import { discover } from "../src/lib/virtualizor";

async function main() {
const d = await discover();
if (!d.ok) {
  console.error("❌ اتصال ناموفق:", d.error);
  process.exit(1);
}
console.log("✅ اتصال به Virtualizor برقرار است\n");
console.log("Servers (serid):");
for (const s of d.servers) console.log(`  ${s.id}\t${s.name}\t${s.virt}`);
console.log("\nOS templates (osid):");
for (const o of d.os) console.log(`  ${o.id}\t${o.name}\t${o.virt}`);
console.log("\nPlans (plid):");
for (const p of d.plans) console.log(`  ${p.id}\t${p.name}`);
console.log("\nIP pools:");
for (const p of d.pools) console.log(`  ${p.id}\t${p.name}`);
}
main();

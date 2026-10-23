import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pool } from "../src/lib/db";

async function main() {
  const sql = readFileSync(join(process.cwd(), "schema.sql"), "utf-8");
  await pool.query(sql);
  console.log("✅ migration done");
  await pool.end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

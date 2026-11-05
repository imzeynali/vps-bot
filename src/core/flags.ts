import { query, queryOne } from "./db";

/** پرچم‌های ساده (روشن/خاموش) در جدول settings. نیازی به تغییر schema ندارد. */
const key = (name: string) => `flag:${name}`;

export async function getFlag(name: string, def: boolean): Promise<boolean> {
  const r = await queryOne<{ value: string }>("SELECT value FROM settings WHERE key=$1", [key(name)]);
  if (!r) return def;
  return r.value === "1";
}

export async function setFlag(name: string, on: boolean): Promise<void> {
  await query(
    "INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
    [key(name), on ? "1" : "0"],
  );
}

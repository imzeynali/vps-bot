import { config } from "./config";
import { query } from "./db";

/** تنظیمات قابل ویرایش از پنل مدیریت (مقدار دیتابیس بر env اولویت دارد) */
export interface Settings {
  cardNumber: string;
  cardOwner: string;
  support: string;
  minTopup: number;
  minBalanceToBuy: number;
  refPercent: number;
}

export const SETTING_KEYS = ["card_number", "card_owner", "support", "min_topup", "min_balance_to_buy", "ref_percent"] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

let cache: { at: number; value: Settings } | null = null;

export async function getSettings(): Promise<Settings> {
  if (cache && Date.now() - cache.at < 5000) return cache.value;
  const rows = await query<{ key: string; value: string }>("SELECT key, value FROM settings");
  const m = new Map(rows.map((r) => [r.key, r.value]));
  const num = (k: string, d: number) => (m.has(k) && /^\d+$/.test(m.get(k)!) ? Number(m.get(k)) : d);
  const value: Settings = {
    cardNumber: m.get("card_number") ?? config.cardNumber,
    cardOwner: m.get("card_owner") ?? config.cardOwner,
    support: m.get("support") ?? config.support,
    minTopup: num("min_topup", config.minTopup),
    minBalanceToBuy: num("min_balance_to_buy", config.minBalanceToBuy),
    refPercent: num("ref_percent", config.refPercent),
  };
  cache = { at: Date.now(), value };
  return value;
}

export async function setSetting(key: SettingKey, value: string) {
  await query(
    "INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value",
    [key, value],
  );
  cache = null;
}

export async function resetSetting(key: SettingKey) {
  await query("DELETE FROM settings WHERE key=$1", [key]);
  cache = null;
}

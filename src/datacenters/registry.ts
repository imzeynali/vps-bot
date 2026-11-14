import { getFlag, queryOne, setFlag } from "@/core";
import type { DatacenterProvider, Region } from "./types";

const providers = new Map<string, DatacenterProvider>();

export function registerDatacenter(p: DatacenterProvider) {
  if (!/^[a-z0-9_]+$/.test(p.id)) throw new Error(`شناسه‌ی دیتاسنتر نامعتبر: ${p.id}`);
  if (providers.has(p.id)) throw new Error(`دیتاسنتر تکراری: ${p.id}`);
  providers.set(p.id, p);
}

export const getDatacenter = (id: string) => providers.get(id);
export const listDatacenters = (region?: Region) => [...providers.values()].filter((p) => !region || p.region === region);

/** روشن/خاموش بودن در منوی خرید (پیش‌فرض: روشن). خاموش کردن روی سرویس‌های موجود اثری ندارد. */
export const isEnabled = (id: string) => getFlag(`dc_enabled:${id}`, providers.get(id)?.defaultEnabled ?? true);
export const setEnabled = (id: string, on: boolean) => setFlag(`dc_enabled:${id}`, on);

/** قابل خرید = پیاده‌سازی شده + تنظیم‌شده + روشن */
export async function isPurchasable(p: DatacenterProvider): Promise<boolean> {
  return p.implemented && p.isConfigured() && (await isEnabled(p.id));
}

/** دیتاسنتر یک سرویس (سرویس‌های قدیمی بدون مقدار = virtualizor) */
export async function datacenterIdOfService(serviceId: number): Promise<string> {
  const r = await queryOne<{ datacenter: string | null }>("SELECT datacenter FROM services WHERE id=$1", [serviceId]);
  return r?.datacenter || "virtualizor";
}

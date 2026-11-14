import { config } from "@/core";

/**
 * ریجن‌های 3HCloud. هر ریجن Keystone جداگانه‌ی خودش را دارد (آدرس از فایل‌های RC پنل)،
 * ولی کاربر API و پروژه در همه‌ی ریجن‌ها یکی است. توکن هر ریجن جدا گرفته می‌شود.
 * توجه: OS_AUTH_URL در فایل RC پسوند /v3 ندارد؛ کلاینت خودش /v3 را اضافه می‌کند.
 */
export interface Hc3Region {
  key: string; // شناسه‌ی ثابت (حروف کوچک)؛ در دیتابیس/منو استفاده می‌شود
  name: string; // OS_REGION_NAME
  authUrl: string; // OS_AUTH_URL
  zones: string[]; // زون‌های شناخته‌شده (از مستندات)
  title: string; // عنوان منو (پرچم + نام)
}

export const HC3_REGIONS: Hc3Region[] = [
  { key: "miami", name: "Miami", authUrl: "https://identity.api.os.mia.3hcloud.com", zones: ["MIA-1"], title: "🇺🇸 میامی" },
  { key: "dallas", name: "Dallas", authUrl: "https://identity.api.os.dfw.3hcloud.com", zones: ["DFW-1"], title: "🇺🇸 دالاس" },
  { key: "sanfrancisco", name: "SanFrancisco", authUrl: "https://identity.api.os.sfo.3hcloud.com", zones: ["SFO-1"], title: "🇺🇸 سان‌فرانسیسکو" },
  { key: "warsaw", name: "Warsaw", authUrl: "https://identity.api.os.waw.3hcloud.com", zones: ["WAW-1", "WAW-2"], title: "🇵🇱 ورشو" },
  { key: "almaty", name: "Almaty", authUrl: "https://identity.api.os.ala.3hcloud.com", zones: [], title: "🇰🇿 آلماتی" }, // زون در مستندات نیست؛ از hc3:discover
  { key: "manila", name: "Manila", authUrl: "https://identity.api.os.mnl.3hcloud.com", zones: ["MNL-1"], title: "🇵🇭 مانیل" },
];

/** "dallas=https://...,warsaw=https://..." ← نگاشت */
function parseOverride(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  return out;
}

/** ریجن‌ها با اعمال HC3_AUTH_URLS (برای تست یا تغییر آدرس) */
export function hc3Regions(): Hc3Region[] {
  const o = parseOverride(config.hc3.authOverride);
  return HC3_REGIONS.map((r) => ({ ...r, authUrl: (o[r.key] ?? r.authUrl).replace(/\/+$/, "") }));
}

export const hc3Region = (key: string) => hc3Regions().find((r) => r.key === key);

/** Keystone v3: اگر آدرس /v3 ندارد (مثل فایل‌های RC) اضافه می‌شود */
export const keystoneBase = (authUrl: string) => (/\/v3$/.test(authUrl.replace(/\/+$/, "")) ? authUrl.replace(/\/+$/, "") : authUrl.replace(/\/+$/, "") + "/v3");

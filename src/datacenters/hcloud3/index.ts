import { NotReadyError, config } from "@/core";
import type { DatacenterProvider } from "../types";

/**
 * 3HCloud (بین‌الملل) — اسکلت آماده؛ اتصال API هنوز پیاده‌سازی نشده است.
 * پلتفرم OpenStack است (Keystone v3 + Nova + Neutron + Cinder + Glance) و دسترسی API با «کاربر API» (یوزرنیم/پسورد) است.
 *
 * تفاوت‌های مهم با CGI (از مستندات 3HCloud):
 *  - ریجن‌ها: Miami, Dallas, San Francisco, Warsaw, Almaty, Manila (src/datacenters/hcloud3/regions.ts). سهمیه در سطح ریجن است.
 *  - هر ریجن Keystone جداگانه دارد (identity.api.os.<dfw|sfo|mia|waw|ala|mnl>.3hcloud.com) ← برای هر ریجن توکن جدا؛ کاربر API و پروژه مشترک.
 *  - سرور از «volume سیستمی» بوت می‌شود (اندازه/نوع دیسک جدا انتخاب می‌شود و جدا پول دارد) ← Cinder لازم است
 *    (block_device_mapping_v2 با delete_on_termination؛ طبق مستند، volume سیستمی همراه سرور پاک می‌شود).
 *  - آی‌پی روی «پورت» است و پورتِ جداگانه با حذف سرور پاک نمی‌شود؛ IPv4 آن همچنان پول می‌گیرد ← پورت را خودمان حذف می‌کنیم.
 *  - بازنصب سیستم‌عامل روی سرور موجود ممکن نیست (فقط حذف و ساخت دوباره) ← rebuild پشتیبانی نمی‌شود.
 *  - خاموش کردن (SHUTOFF) صورتحساب را متوقف نمی‌کند ← تعلیق سرویس هزینه‌ی دیتاسنتر را قطع نمی‌کند.
 *  - وضعیت‌ها: فقط ACTIVE و SHUTOFF؛ ریبوت نرم و سخت دارد.
 *
 * وقتی اطلاعات کشف (npm run hc3:discover) رسید: متدهای زیر پیاده می‌شوند و implemented=true می‌شود.
 */
const NOT_READY = () => new NotReadyError("hcloud3", "دیتاسنتر 3HCloud هنوز فعال نشده است");

export const isConfigured = () => !!(config.hc3.username && config.hc3.password && (config.hc3.projectId || config.hc3.projectName));

export const hcloud3Datacenter: DatacenterProvider = {
  id: "hcloud3",
  title: "3HCloud",
  region: "intl",
  implemented: false,
  defaultEnabled: false, // تا آماده نشده در منوی خرید دیده نمی‌شود

  isConfigured,

  async health() {
    return { ok: false, detail: isConfigured() ? "تنظیمات هست؛ پیاده‌سازی API در دست توسعه است" : "HC3_* در .env.local تنظیم نشده (در دست توسعه)" };
  },

  async provision() {
    throw NOT_READY();
  },
  async power() {
    throw NOT_READY();
  },
  async rebuild() {
    throw NOT_READY(); // پلتفرم بازنصب ندارد؛ بعداً به «پشتیبانی نمی‌شود» تبدیل می‌شود
  },
  async remove() {
    throw NOT_READY();
  },
  async refreshIp() {
    throw NOT_READY();
  },

  isDefinitiveFailure: () => true, // هنوز چیزی ساخته نمی‌شود
  async removeOrphan() {
    throw NOT_READY();
  },
  async findExisting() {
    return null;
  },
};

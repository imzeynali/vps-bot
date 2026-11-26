/**
 * نقطه‌ی ورود لایه‌ی دیتاسنترها. برای افزودن دیتاسنتر جدید:
 *   ۱) پوشه‌ی src/datacenters/<id>/ با یک DatacenterProvider بسازید
 *   ۲) اینجا import و registerDatacenter کنید
 * (راهنمای کامل: docs/ARCHITECTURE.md)
 */
import { registerDatacenter } from "./registry";
import { virtualizorDatacenter } from "./virtualizor";
import { cgiDatacenter } from "./cgi";
import { h3cDatacenter } from "./h3c";
import { virtuaDatacenter } from "./virtua";

const g = globalThis as unknown as { __dcRegistered?: boolean };
if (!g.__dcRegistered) {
  // جلوگیری از ثبت دوباره هنگام hot-reload / بارگذاری چندباره‌ی ماژول
  g.__dcRegistered = true;
  registerDatacenter(virtualizorDatacenter); // 🇮🇷 ایران
  registerDatacenter(cgiDatacenter); // 🌍 بین‌الملل
  registerDatacenter(h3cDatacenter); // 🌍 بین‌الملل (3HCloud)
  registerDatacenter(virtuaDatacenter); // 🌍 بین‌الملل (Virtua.Cloud)
}

export * from "./registry";
export * from "./types";

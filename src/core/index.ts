/**
 * Base core — هسته‌ی پایه‌ی ربات.
 * هر چیزِ مشترک و مستقل از دیتاسنتر اینجاست: تنظیمات محیطی، دیتابیس، state کاربر، تنظیمات قابل‌ویرایش،
 * پرچم‌ها، خطاها، لاگ. هیچ‌چیز در core به دیتاسنتر خاصی وابسته نیست (جهت وابستگی همیشه: datacenters → core).
 */
export * from "./config";
export * from "./db";
export * from "./state";
export * from "./settings";
export * from "./flags";
export * from "./errors";
export * from "./logger";
export * from "./password";
export const BOT_VERSION = "2.0.0";

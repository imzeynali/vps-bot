/**
 * قرارداد مشترک همه‌ی دیتاسنترها.
 * هر دیتاسنتر یک پوشه‌ی مستقل در src/datacenters/<id>/ دارد، این اینترفیس را پیاده می‌کند و در index.ts ثبت می‌شود.
 * قانون: کد یک دیتاسنتر هرگز دیتاسنتر دیگری را import نمی‌کند؛ فقط core و این types.
 */
export type Region = "ir" | "intl";
export type PowerAction = "on" | "off" | "reboot";

export interface ProvisionResult {
  /** شناسه‌ی عددی (Virtualizor). دیتاسنترهای با شناسه‌ی متنی null می‌گذارند. */
  vpsId: number | null;
  /** شناسه‌ی متنی سرور در دیتاسنتر (مثلاً UUID در OpenStack) */
  externalId?: string;
  ip: string | null;
  /** داده‌ی کمکی دیتاسنتر که باید ذخیره شود (مثلاً port_id) */
  meta?: Record<string, unknown>;
}

export interface HealthResult {
  ok: boolean;
  detail: string;
  ms?: number;
}

export interface DatacenterProvider {
  /** شناسه‌ی یکتا و ثابت (حروف کوچک/عدد/_) — در دیتابیس (services.datacenter) ذخیره می‌شود */
  readonly id: string;
  /** نام نمایشی برای کاربر */
  readonly title: string;
  /** ایران (Virtualizor) یا بین‌الملل */
  readonly region: Region;
  /** آیا کد اتصال (API) کامل پیاده‌سازی شده؟ false = «به‌زودی» */
  readonly implemented: boolean;

  /** تنظیمات محیطی (آدرس/کلید API) برای اتصال کافی است؟ */
  isConfigured(): boolean;
  /** بررسی اتصال به API دیتاسنتر (برای پنل ادمین) */
  health(): Promise<HealthResult>;

  // ── عملیات روی «سرویس» (بر اساس شناسه‌ی سرویس در دیتابیس ربات) ──
  provision(serviceId: number): Promise<ProvisionResult>;
  power(serviceId: number, action: PowerAction): Promise<void>;
  rebuild(serviceId: number, osKey: string): Promise<{ password: string }>;
  remove(serviceId: number): Promise<void>;
  refreshIp(serviceId: number): Promise<string | null>;

  // ── مدیریت خطا و بازیابی (منطق مخصوص هر دیتاسنتر از هسته جدا می‌ماند) ──
  /** خطای ساخت «قطعی» است (یعنی هیچ سروری ساخته نشده ← بازگشت وجه)؟ false = نتیجه نامشخص (timeout/قطع اتصال) */
  isDefinitiveFailure(e: unknown): boolean;
  /** سرور یتیم (ساخته‌شده ولی سرویس لغو شده) را حذف می‌کند */
  removeOrphan(res: ProvisionResult): Promise<void>;
  /** سرویسِ گیرکرده در provisioning: اگر سرور از قبل ساخته شده باشد پیدایش می‌کند، وگرنه null */
  findExisting(serviceId: number): Promise<ProvisionResult | null>;
}

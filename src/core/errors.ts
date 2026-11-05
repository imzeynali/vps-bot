/** خطاهای مشترک هسته. هر خطای مربوط به یک دیتاسنتر با شناسه‌ی آن علامت‌گذاری می‌شود تا گزارش و عیب‌یابی دقیق باشد. */

/** دیتاسنتر هنوز پیاده‌سازی/متصل نشده است (خطای قابل‌انتظار، نه باگ) */
export class NotReadyError extends Error {
  readonly datacenter: string;
  constructor(datacenter: string, message = "این دیتاسنتر هنوز فعال نشده است") {
    super(message);
    this.name = "NotReadyError";
    this.datacenter = datacenter;
  }
}

/** شناسه‌ی دیتاسنتر را روی خطا می‌گذارد (بدون تغییر کلاس خطا، پس instanceof ها سالم می‌مانند) */
export function tagDatacenter<T>(e: T, datacenter: string): T {
  if (e && typeof e === "object" && !("datacenter" in e)) {
    try {
      Object.defineProperty(e, "datacenter", { value: datacenter, enumerable: false, configurable: true });
    } catch {
      /* خطای frozen؛ مهم نیست */
    }
  }
  return e;
}

export const datacenterOfError = (e: unknown): string | null =>
  e && typeof e === "object" && "datacenter" in e ? String((e as { datacenter: unknown }).datacenter) : null;

export const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

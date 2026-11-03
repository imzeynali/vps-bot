/**
 * دیتاسنترهای «بین‌الملل». این‌ها هیچ ارتباطی با Virtualizor ندارند (Virtualizor فقط برای ایران است)
 * و هر دیتاسنتر API جداگانه‌ی خودش را خواهد داشت. برای افزودن دیتاسنتر جدید فقط یک مورد به این لیست اضافه کنید.
 */
export interface Datacenter {
  key: string; // فقط حروف/عدد/_ (در callback_data استفاده می‌شود)
  title: string;
  ready: boolean; // false = هنوز API وصل نشده؛ کاربر پیام «به‌زودی» می‌بیند
}

export const DATACENTERS: Datacenter[] = [{ key: "cgi", title: "CGI", ready: false }];

export const getDatacenter = (key: string) => DATACENTERS.find((d) => d.key === key);

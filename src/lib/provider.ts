import { randomBytes } from "node:crypto";

/**
 * ─────────────────────────────────────────────────────────────
 *  لایه اتصال به ارائه‌دهنده سرور (Proxmox / پنل مجازی‌سازی / ...)
 *  همه توابع زیر فعلاً نمونه (stub) هستند و هیچ سرور واقعی‌ای نمی‌سازند.
 *  بدنه هر تابع را با فراخوانی API ارائه‌دهنده خودتان جایگزین کنید.
 * ─────────────────────────────────────────────────────────────
 */

export type PowerAction = "on" | "off" | "reboot";

export interface ProvisionResult {
  ip: string;
  username: string;
  password: string;
}

const genPassword = () => randomBytes(9).toString("base64url");

export async function provisionServer(opts: {
  serviceId: number;
  planName: string;
  osName: string;
}): Promise<ProvisionResult> {
  // TODO: ساخت VM روی ارائه‌دهنده با ایمیج opts.osName
  void opts;
  return { ip: "در حال آماده‌سازی", username: "root", password: genPassword() };
}

export async function powerAction(serviceId: number, action: PowerAction): Promise<void> {
  // TODO: روشن / خاموش / ریبوت سرور روی ارائه‌دهنده
  void serviceId;
  void action;
}

export async function rebuildServer(serviceId: number, osName: string): Promise<{ password: string }> {
  // TODO: نصب مجدد سیستم‌عامل osName روی سرور و دریافت پسورد جدید
  void serviceId;
  void osName;
  return { password: genPassword() };
}

export async function deleteServer(serviceId: number): Promise<void> {
  // TODO: حذف سرور از ارائه‌دهنده
  void serviceId;
}

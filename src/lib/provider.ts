/**
 * مسیریاب عملیات سرویس‌ها: هر عملیات به دیتاسنترِ همان سرویس (services.datacenter) هدایت می‌شود.
 * API این فایل با قبل یکسان است، پس provisioning/billing/trial/services بدون تغییر کار می‌کنند.
 * خطای هر دیتاسنتر با شناسه‌ی همان دیتاسنتر علامت‌گذاری می‌شود (برای گزارش دقیق) و به بقیه سرایت نمی‌کند.
 */
import { NotReadyError, genPassword, tagDatacenter } from "@/core";
import { datacenterIdOfService, getDatacenter } from "@/datacenters";
import type { DatacenterProvider, PowerAction, ProvisionResult } from "@/datacenters";

export type { PowerAction, ProvisionResult };
export { genPassword };
// ابزارهای نام‌گذاری مخصوص ایران (Virtualizor) — برای سازگاری با کدهای موجود
export { seqOf, hostnameFor, panelEmailFor, importPanelPlans } from "@/datacenters/virtualizor/service";
export type { ImportedPlan } from "@/datacenters/virtualizor/service";

async function dcOf(serviceId: number): Promise<DatacenterProvider> {
  const id = await datacenterIdOfService(serviceId);
  const p = getDatacenter(id);
  if (!p) throw new Error(`دیتاسنتر «${id}» برای سرویس #${serviceId} ثبت نشده است`);
  return p;
}

async function run<T>(serviceId: number, fn: (p: DatacenterProvider) => Promise<T>): Promise<T> {
  const p = await dcOf(serviceId);
  try {
    return await fn(p);
  } catch (e) {
    throw tagDatacenter(e, p.id);
  }
}

export const provisionServer = (serviceId: number) =>
  run(serviceId, async (p) => {
    if (!p.implemented || !p.isConfigured()) throw new NotReadyError(p.id, `دیتاسنتر ${p.title} هنوز فعال نشده است`);
    return p.provision(serviceId);
  });
export const powerAction = (serviceId: number, action: PowerAction) => run(serviceId, (p) => p.power(serviceId, action));
export const rebuildServer = (serviceId: number, osKey: string) => run(serviceId, (p) => p.rebuild(serviceId, osKey));
/** خطای ساخت قطعی است؟ (NotReady همیشه قطعی است؛ بقیه را خود دیتاسنتر تشخیص می‌دهد) */
export async function isDefinitiveFailure(serviceId: number, e: unknown): Promise<boolean> {
  if (e instanceof NotReadyError) return true;
  return (await dcOf(serviceId)).isDefinitiveFailure(e);
}
export const removeOrphan = (serviceId: number, res: ProvisionResult) => run(serviceId, (p) => p.removeOrphan(res));
export const findExisting = (serviceId: number) => run(serviceId, (p) => p.findExisting(serviceId));
export const deleteServer = (serviceId: number) => run(serviceId, (p) => p.remove(serviceId));
export const refreshIp = (serviceId: number) => run(serviceId, (p) => p.refreshIp(serviceId));

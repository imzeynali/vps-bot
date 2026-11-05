import type { DatacenterProvider } from "../types";
import * as V from "./api";
import { deleteServer, hostnameFor, powerAction, provisionServer, rebuildServer, refreshIp } from "./service";

/** دیتاسنتر ایران — Virtualizor. همه‌ی لوکیشن‌ها/OS/پلن‌های فعلی ربات متعلق به همین دیتاسنتر هستند. */
export const virtualizorDatacenter: DatacenterProvider = {
  id: "virtualizor",
  title: "ایران",
  region: "ir",
  implemented: true,

  isConfigured: () => V.isConfigured(),

  async health() {
    if (!V.isConfigured()) return { ok: false, detail: "VIRT_URL / VIRT_API_KEY / VIRT_API_PASS تنظیم نشده" };
    const t0 = Date.now();
    const d = await V.discover();
    const ms = Date.now() - t0;
    if (!d.ok) return { ok: false, detail: d.error ?? "اتصال برقرار نشد", ms };
    return { ok: true, detail: `${d.servers.length} نود، ${d.os.length} قالب OS، ${d.plans.length} پلن`, ms };
  },

  provision: provisionServer,
  power: powerAction,
  rebuild: rebuildServer,
  remove: deleteServer,
  refreshIp,

  isDefinitiveFailure: (e) => e instanceof V.VirtError && e.kind === "panel",
  removeOrphan: (vpsId) => V.deleteVps(vpsId),
  async findExisting(serviceId) {
    const vps = await V.findByHostname(hostnameFor(serviceId));
    return vps ? { vpsId: vps.vpsid, ip: vps.ips[0] ?? null } : null;
  },
};

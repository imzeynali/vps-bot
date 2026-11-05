import { NotReadyError, config } from "@/core";
import type { DatacenterProvider } from "../types";

/**
 * CGI (بین‌الملل) — اسکلت آماده. API هنوز متصل نشده است.
 * وقتی API مشخص شد: متدهای زیر را پیاده کنید، `implemented` را true کنید و CGI_API_URL / CGI_API_KEY را در .env.local بگذارید.
 * هیچ بخش دیگری از ربات نیاز به تغییر ندارد.
 */
const NOT_READY = () => new NotReadyError("cgi", "دیتاسنتر CGI هنوز فعال نشده است");

export const cgiDatacenter: DatacenterProvider = {
  id: "cgi",
  title: "CGI",
  region: "intl",
  implemented: false,

  isConfigured: () => !!(config.cgi.url && config.cgi.apiKey),

  async health() {
    return { ok: false, detail: "API هنوز پیاده‌سازی نشده (در دست توسعه)" };
  },

  async provision() {
    throw NOT_READY();
  },
  async power() {
    throw NOT_READY();
  },
  async rebuild() {
    throw NOT_READY();
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

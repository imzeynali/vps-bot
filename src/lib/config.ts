const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return v && Number.isFinite(n) ? n : d;
};

export const config = {
  botToken: process.env.BOT_TOKEN ?? "",
  webhookSecret: process.env.WEBHOOK_SECRET ?? "",
  cronSecret: process.env.CRON_SECRET ?? "",
  admins: (process.env.ADMIN_IDS ?? "")
    .split(",")
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isInteger(x) && x > 0),
  support: process.env.SUPPORT_USERNAME ?? "@support",
  cardNumber: process.env.CARD_NUMBER ?? "6037-0000-0000-0000",
  cardOwner: process.env.CARD_OWNER ?? "نام صاحب کارت",
  minTopup: num(process.env.MIN_TOPUP, 10000),
  minBalanceToBuy: num(process.env.MIN_BALANCE_TO_BUY, 100000),
  refPercent: num(process.env.REF_PERCENT, 10),

  // ── اتصال به پنل Virtualizor (Admin API) ──
  virt: {
    url: (process.env.VIRT_URL ?? "").trim().replace(/\/+$/, ""), // مثلاً https://panel.example.com:4085
    apiKey: process.env.VIRT_API_KEY ?? "",
    apiPass: process.env.VIRT_API_PASS ?? "",
    insecureTls: process.env.VIRT_INSECURE_TLS === "1", // برای گواهی self-signed
    type: process.env.VIRT_TYPE ?? "kvm", // kvm / openvz / lxc / xen ...
    // به‌ازای هر خرید یک کاربر اختصاصی در پنل ساخته می‌شود: <userPrefix><N>@<userDomain>
    // N = userStart + شناسه سرویس − ۱  (مثلاً tetaclouduser1001@mizban.com)
    userPrefix: (process.env.VIRT_USER_PREFIX ?? "vpsuser").trim(),
    userDomain: (process.env.VIRT_USER_DOMAIN ?? "").trim(),
    userStart: num(process.env.VIRT_USER_START, 1001),
    // حالت قدیمی (یک کاربر مشترک)؛ فقط اگر VIRT_USER_DOMAIN خالی باشد استفاده می‌شود
    ownerUid: num(process.env.VIRT_OWNER_UID, 0),
    ownerEmail: process.env.VIRT_OWNER_EMAIL ?? "", // یا ایمیل+پسورد تا خودکار ساخته شود
    ownerPass: process.env.VIRT_OWNER_PASS ?? "",
    ipPoolId: num(process.env.VIRT_IP_POOL_ID, 0), // اختیاری
    storageUuid: process.env.VIRT_STORAGE_UUID ?? "", // اختیاری (پنل‌های multi-storage)
    timeoutMs: num(process.env.VIRT_TIMEOUT_MS, 60000),
  },
  // دامنه‌ی hostname سرورها: s<ID>.<vpsDomain>
  vpsDomain: (process.env.VPS_DOMAIN || hostOf(process.env.APP_URL) || "vps.local").toLowerCase(),
  // الگوی hostname: {n} شماره (مثلاً 1001) ، {id} شناسه سرویس ، {domain} دامنه بالا
  // مثال: tetacloud.s{n}.com  →  tetacloud.s1001.com
  vpsHostnameTemplate: (process.env.VPS_HOSTNAME_TEMPLATE || "s{n}.{domain}").trim(),
};

function hostOf(u?: string) {
  try {
    return u ? new URL(u).hostname : "";
  } catch {
    return "";
  }
}

export const TERMS = `📜 <b>شرایط و ضوابط</b>

۱. هزینه سرویس به‌صورت ساعتی از موجودی کیف پول کسر می‌شود (حتی در حالت خاموش، چون منابع برای شما رزرو است).
۲. در صورت اتمام موجودی، سرویس به‌صورت خودکار متوقف می‌شود.
۳. استفاده از سرویس برای فعالیت‌های مغایر با قوانین ممنوع است.
۴. مسئولیت محتوا و فعالیت روی سرور بر عهده کاربر است.
۵. ریبیلد (نصب مجدد) تمام اطلاعات سرور را پاک می‌کند.
۶. وجه شارژشده قابل برگشت نیست مگر با تأیید پشتیبانی.`;

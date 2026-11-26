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
  // ── دیتاسنتر CGI (بین‌الملل) — API هنوز متصل نشده؛ مقادیر بعداً تکمیل می‌شود ──
  cgi: {
    authUrl: (process.env.CGI_AUTH_URL ?? "").trim().replace(/\/+$/, ""), // …/identity/v3
    credId: (process.env.CGI_APP_CRED_ID ?? "").trim(),
    credSecret: process.env.CGI_APP_CRED_SECRET ?? "",
    region: (process.env.CGI_REGION ?? "eu-north3").trim(),
    securityGroup: (process.env.CGI_SECURITY_GROUP ?? "allow_all").trim(), // نام گروه امنیتی (ورودی/خروجی باز)
    novaVersion: (process.env.CGI_NOVA_MICROVERSION ?? "2.79").trim(),
    timeoutMs: num(process.env.CGI_TIMEOUT_MS, 30000),
    buildTimeoutMs: num(process.env.CGI_BUILD_TIMEOUT_MS, 240000), // سقف انتظار تا ACTIVE شدن سرور
    pollMs: num(process.env.CGI_POLL_MS, 3000), // فاصله‌ی پولینگ وضعیت
  },
  // ── دیتاسنتر 3HCloud (بین‌الملل) — OpenStack با کاربر API (نام‌کاربری/رمز؛ مقادیر فایل RC پنل) ──
  h3c: {
    // هر ریجن Keystone مخصوص خود را دارد: {code} با کد ریجن (mia dfw sfo waw ala mnl) جایگزین می‌شود
    authUrl: (process.env.H3C_AUTH_URL || "https://identity.api.os.{code}.3hcloud.com").trim().replace(/\/+$/, ""),
    authUrls: process.env.H3C_AUTH_URLS ?? "", // (اختیاری) جایگزینی دستی: "Dallas=https://...,Miami=https://..."
    username: (process.env.H3C_USERNAME ?? "").trim(),
    password: process.env.H3C_PASSWORD ?? "",
    userDomain: (process.env.H3C_USER_DOMAIN ?? "Default").trim(),
    project: (process.env.H3C_PROJECT ?? "").trim(), // نام یا شناسه‌ی پروژه (OS_PROJECT_NAME / OS_PROJECT_ID)
    projectDomain: (process.env.H3C_PROJECT_DOMAIN ?? "Default").trim(),
    region: (process.env.H3C_REGION ?? "").trim(), // ریجن پیش‌فرض برای خواندن کاتالوگ
    network: (process.env.H3C_NETWORK ?? "").trim(), // نام شبکه‌ی خارجی (اگر خالی: شبکه‌های router:external)
    securityGroup: (process.env.H3C_SECURITY_GROUP ?? "allow_all").trim(),
    volumeType: (process.env.H3C_VOLUME_TYPE ?? "").trim(), // نوع دیسک سیستم (Cinder)؛ خالی = پیش‌فرض
    diskGb: num(process.env.H3C_DISK_GB, 40), // اندازه‌ی دیسک سیستم برای پلن‌هایی که فلورشان دیسک ندارد
    novaVersion: (process.env.H3C_NOVA_MICROVERSION ?? "2.79").trim(),
    timeoutMs: num(process.env.H3C_TIMEOUT_MS, 30000),
    buildTimeoutMs: num(process.env.H3C_BUILD_TIMEOUT_MS, 600000), // ساخت از روی volume کندتر است
    pollMs: num(process.env.H3C_POLL_MS, 4000),
  },
  // ── دیتاسنتر Virtua.Cloud (بین‌الملل، فرانسه) — API ساده با کلید ──
  virtua: {
    apiUrl: (process.env.VIRTUA_API_URL || "https://api.virtua.cloud").trim().replace(/\/+$/, ""),
    apiKey: (process.env.VIRTUA_API_KEY ?? "").trim(),
    project: (process.env.VIRTUA_PROJECT ?? "").trim(), // UUID پروژه؛ خالی = اولین پروژه‌ی حساب
    /** نام فیلدی از جزئیات سرور که پسورد root را دارد (بعد از «npm run virtua:discover» تعیین می‌شود) */
    passwordField: (process.env.VIRTUA_PASSWORD_FIELD ?? "").trim(),
    /** JSON اضافه برای سفارش؛ «{password}» با پسورد ربات جایگزین می‌شود. مثال: {"root_password":"{password}"} */
    orderExtra: process.env.VIRTUA_ORDER_EXTRA ?? "",
    timeoutMs: num(process.env.VIRTUA_TIMEOUT_MS, 30000),
    buildTimeoutMs: num(process.env.VIRTUA_BUILD_TIMEOUT_MS, 480000),
    pollMs: num(process.env.VIRTUA_POLL_MS, 4000),
  },
  // ── دیتاسنتر UpCloud (بین‌الملل) — API با توکن Bearer (ucat_…) ──
  upcloud: {
    apiUrl: (process.env.UPCLOUD_API_URL || "https://api.upcloud.com/1.3").trim().replace(/\/+$/, ""),
    token: (process.env.UPCLOUD_TOKEN ?? "").trim(),
    /** زون‌هایی که لوکیشن می‌شوند (جدا با کاما)؛ فقط زون‌های موجود در حساب ساخته می‌شوند */
    zones: (process.env.UPCLOUD_ZONES || "fi-hel1,de-fra1,nl-ams1,uk-lon1,us-nyc1,sg-sin1,pl-waw1,es-mad1").split(",").map((z) => z.trim()).filter(Boolean),
    /** userdata: پسورد ربات با cloud-init (user_data) ثبت می‌شود؛ api: پسورد ساخته‌شده‌ی UpCloud از پاسخ ساخت خوانده می‌شود */
    passwordMode: (process.env.UPCLOUD_PASSWORD_MODE === "api" ? "api" : "userdata") as "api" | "userdata",
    tier: (process.env.UPCLOUD_TIER || "maxiops").trim(),
    timeoutMs: num(process.env.UPCLOUD_TIMEOUT_MS, 30000),
    buildTimeoutMs: num(process.env.UPCLOUD_BUILD_TIMEOUT_MS, 360000),
    pollMs: num(process.env.UPCLOUD_POLL_MS, 4000),
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

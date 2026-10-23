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
};

export const LOCATIONS: Record<string, string> = {
  iran: "🇮🇷 ایران",
};

export const OS_LIST: Record<string, string> = {
  u20: "Ubuntu 20.04",
  u22: "Ubuntu 22.04",
  u24: "Ubuntu 24.04",
};

export const TERMS = `📜 <b>شرایط و ضوابط</b>

۱. هزینه سرویس به‌صورت ساعتی از موجودی کیف پول کسر می‌شود (حتی در حالت خاموش، چون منابع برای شما رزرو است).
۲. در صورت اتمام موجودی، سرویس به‌صورت خودکار متوقف می‌شود.
۳. استفاده از سرویس برای فعالیت‌های مغایر با قوانین ممنوع است.
۴. مسئولیت محتوا و فعالیت روی سرور بر عهده کاربر است.
۵. ریبیلد (نصب مجدد) تمام اطلاعات سرور را پاک می‌کند.
۶. وجه شارژشده قابل برگشت نیست مگر با تأیید پشتیبانی.`;

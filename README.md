# ربات فروش سرور مجازی (Next.js + TypeScript + grammY + PostgreSQL)

## ⚡ نصب سریع روی اوبونتو (۲۰.۰۴ به بالا)
روی سرور (با کاربر root) فقط یک دستور بزنید و مراحل منوی انگلیسی را دنبال کنید
(`OWNER/REPO` را با آدرس گیت‌هاب خودتان عوض کنید):
```bash
bash <(curl -Ls https://raw.githubusercontent.com/OWNER/REPO/main/install.sh)
```
اگر با `sudo` اجرا می‌کنید این فرم مطمئن‌تر است:
```bash
sudo bash -c "$(curl -Ls https://raw.githubusercontent.com/OWNER/REPO/main/install.sh)"
```
نصب‌کننده خودکار این موارد را انجام می‌دهد: Node.js 22، PostgreSQL، Nginx، SSL رایگان (Let's Encrypt)،
ساخت دیتابیس و جدول‌ها، build، سرویس systemd، تایمر صورتحساب هر دقیقه و ثبت وبهوک تلگرام.

بعد از نصب، در هر جای سرور دستور `vpsbot` منوی مدیریت را باز می‌کند
(`vpsbot update` · `vpsbot logs` · `vpsbot restart` · `vpsbot status` · `vpsbot backup` · `vpsbot webhook`).

> پیش‌نیاز: یک دامنه که A-record آن به IP سرور اشاره کند (تلگرام فقط وبهوک HTTPS می‌پذیرد).
> متغیرهای اختیاری: `VPSBOT_REPO=owner/repo` ، `VPSBOT_BRANCH=main` ، `VPSBOT_NPM_REGISTRY=<mirror>`

---

## راه‌اندازی دستی
```bash
npm install
cp .env.example .env.local     # و مقادیر را پر کنید
npm run migrate                # ساخت جدول‌ها و پلن‌های نمونه
npm run build && npm start     # یا npm run dev
npm run webhook                # ثبت وبهوک تلگرام (APP_URL باید https باشد)
```

## صورتحساب ساعتی (cron)
Next.js حلقه پس‌زمینه ندارد؛ باید هر دقیقه این آدرس صدا زده شود:
```
* * * * * curl -s -H "Authorization: Bearer $CRON_SECRET" https://your-domain.com/api/cron/billing
```

## اتصال به ارائه‌دهنده سرور
همه توابع در `src/lib/provider.ts` نمونه (stub) هستند: provisionServer, powerAction (on/off/reboot), rebuildServer, deleteServer.

## ساختار
- `app/api/telegram/route.ts` وبهوک تلگرام
- `app/api/cron/billing/route.ts` کسر ساعتی
- `src/bot/handlers/` منوها (start, buy, services, wallet, admin)
- `src/lib/` دیتابیس، تنظیمات، provider، billing

## پنل مدیریت
ادمین‌ها (آیدی‌های `ADMIN_IDS`) با `/start` دکمه «🛠 پنل مدیریت» را در منوی اصلی می‌بینند (یا دستور `/admin`):
- 👥 مدیریت کاربران: لیست صفحه‌بندی‌شده کاربران
- 📊 آمار ربات: فروش، کاربران جدید، کل کاربران، سرورهای فعال/غیرفعال
- 📢 ارسال پیام همگانی: هر نوع پیام (متن/عکس/...) با پیش‌نمایش و تأیید
- 💰 مدیریت موجودی: ادمین آیدی عددی تلگرام کاربر را می‌فرستد، اطلاعات و موجودی او را می‌بیند و با «➕ افزایش / ➖ کاهش» و تأیید نهایی موجودی را تغییر می‌دهد. کاهش بیشتر از موجودی مجاز نیست، هر تغییر در جدول `balance_adjustments` ثبت می‌شود و به کاربر اطلاع‌رسانی می‌شود.

> ارسال همگانی در پس‌زمینه اجرا می‌شود؛ ربات باید روی سرور دائمی (`next start`) اجرا شود نه Serverless.
> بعد از آپدیت یک‌بار `npm run migrate` را اجرا کنید (ستون `payments.approved_at` و جدول `balance_adjustments`).

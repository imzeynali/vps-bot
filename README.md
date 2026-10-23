# ربات فروش سرور مجازی (Next.js + TypeScript + grammY + PostgreSQL)

## راه‌اندازی
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

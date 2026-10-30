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

---

## 🔌 اتصال به Virtualizor (ساخت و مدیریت واقعی سرور)

ربات با **Virtualizor Admin API** (پورت ۴۰۸۵) کار می‌کند:

| در ربات | در Virtualizor |
|---|---|
| خرید سرویس | `act=addvs` (ساخت VPS با hostname یکتا `s<ID>.<دامنه>`) |
| روشن / خاموش / ریبوت | `act=vs&action=start / poweroff / restart` |
| ریبیلد | `act=rebuild` (پسورد جدید) |
| حذف سرور | `act=vs&delete=<vpsid>` |

**راه‌اندازی (یک‌بار):**
1. در پنل: *Configuration → API Credentials* یک جفت Key/Pass بسازید و (اگر IP-restriction دارید) IP سرور ربات را مجاز کنید. مقادیر `VIRT_URL`، `VIRT_API_KEY`، `VIRT_API_PASS` را در `.env.local` بگذارید (نصب‌کننده هم می‌پرسد).
2. در تلگرام (ادمین) → پنل مدیریت → **🔌 اتصال Virtualizor** یا دستور `/virt`: اتصال تست می‌شود و شناسه Nodeها (`serid`) و OS Templateها (`osid`) نمایش داده می‌شود (`/virt ubuntu` برای فیلتر).
3. تعریف کاتالوگ فروش:
```
/addloc iran|🇮🇷 ایران|0
/addos u22|Ubuntu 22.04|123
/addplan برنزی|1|1|20|300          (اختیاری: |plid برای اتصال به Plan پنل)
/catalog   /delloc کلید   /delos کلید
```

**رفتار مهم**
- بعد از کسر هزینه، ساخت در **پس‌زمینه** انجام و مشخصات در تلگرام ارسال می‌شود؛ اگر پنل خطا بدهد **هزینه خودکار برگشت** می‌خورد و ادمین پیام خطا را می‌گیرد.
- اگر در حین ساخت timeout شود (نتیجه نامشخص)، تایمر دقیقه‌ای بعد از ۱۰ دقیقه پنل را با hostname چک می‌کند: VPS هست ← فعال می‌شود، نیست ← برگشت پول.
- حذف سرور ابتدا روی پنل انجام می‌شود؛ اگر خطا بدهد سرویس فعال می‌ماند (سرور یتیم نمی‌ماند).
- «خاموش» = `poweroff` (فوری).
- تست خودکار با پنل شبیه‌ساز: `npm run test:virt` (نیاز به `DATABASE_URL`).

### 👤 کاربر و hostname اختصاصی برای هر خرید
به‌ازای هر خرید یک کاربر جدید در Virtualizor ساخته و سرور با hostname اختصاصی روی همان کاربر ایجاد می‌شود:

| متغیر | مثال | نتیجه |
|---|---|---|
| `VIRT_USER_PREFIX` / `VIRT_USER_DOMAIN` | `tetaclouduser` / `mizban.com` | `tetaclouduser1001@mizban.com` |
| `VIRT_USER_START` | `1001` | شماره‌ی اولین سرویس (N = START + شناسه سرویس − ۱) |
| `VPS_HOSTNAME_TEMPLATE` | `tetacloud.s{n}.com` | `tetacloud.s1001.com` |

اگر `VIRT_USER_DOMAIN` خالی باشد، حالت قدیمی (یک کاربر مشترک با `VIRT_OWNER_*`) استفاده می‌شود.

### 💳 نوع پرداخت: ساعتی یا ماهانه
بعد از انتخاب پلن، اطلاعات کامل و دو دکمه‌ی «⏰ ساعتی» و «🗓 ماهانه» نمایش داده می‌شود (ماهانه فقط اگر برای پلن `قیمت ماهانه` ثبت شده باشد: `/setplan`).

- **ساعتی:** هزینه‌ی یک ساعت هنگام خرید کسر می‌شود و هر ساعت از موجودی کم می‌شود.
- **ماهانه:** هزینه‌ی **یک روز** (قیمت ماهانه ÷ ۳۰) برای تست کسر می‌شود. کاربر ۲۴ ساعت فرصت دارد با دکمه‌ی «⚠️ گزارش مشکل» (در سرویس‌های من) مشکل را اعلام کند.
  - مشکلی گزارش نشد ← بعد از ۲۴ ساعت **مابقی** قیمت ماهانه کسر می‌شود (مجموع = قیمت ماهانه) و سپس هر ۳۰ روز تمدید می‌شود.
  - گزارش مشکل شد ← کسر متوقف و برای ادمین پیام با دو دکمه ارسال می‌شود: «✅ ادامه تمدید» (`/trialok شناسه`) یا «🗑 لغو و بازگشت وجه» (`/trialcancel شناسه`؛ سرور از پنل حذف و هزینه‌ی روز تست برگردانده می‌شود).
  - اگر در سررسید موجودی کافی نباشد سرور خاموش/متوقف می‌شود؛ ۶ ساعت قبل از سررسید هم یک هشدار شارژ برای کاربر ارسال می‌شود.

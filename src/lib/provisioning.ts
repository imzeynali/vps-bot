import type { Api } from "grammy";
import { query, queryOne, withTx } from "./db";
import { findExisting, isDefinitiveFailure, provisionServer, removeOrphan } from "./provider";
import type { ProvisionResult } from "./provider";
import { datacenterOfError } from "@/core/errors";
import { getDatacenter } from "@/datacenters";
import { getSettings } from "./settings";
import { codes, payerInfo, report, reportError, stamp } from "./adminGroup";

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const WAIT_KB = { inline_keyboard: [[{ text: "📦 سرویس‌های من", callback_data: "services" }]] };

async function tell(api: Api, userId: number, text: string, kb = true) {
  await api
    .sendMessage(userId, text, { parse_mode: "HTML", ...(kb ? { reply_markup: WAIT_KB } : {}) })
    .catch(() => {});
}

/** خطاها ← تاپیک «خطا» در گروه مدیریتی (اگر گروه نباشد، پیام خصوصی به ادمین‌ها) */
async function tellAdmins(api: Api, text: string) {
  await reportError(api, text);
}

interface Cred {
  id: number;
  /** مشخصات سرویس برای پیام تحویل (اختیاری) */
  detail?: { plan: string; cpu: number; ram_gb: number; disk_gb: number; location: string | null; os: string | null; meta: { network?: string; bandwidth?: number } };
  ip: string | null;
  login_user: string | null;
  login_pass: string | null;
  billing_mode?: string;
  initial_charge?: number;
  monthly_price?: number | null;
}

function credentials(s: Cred) {
  const monthly =
    s.billing_mode === "monthly"
      ? `\n\n🗓 <b>سرویس ماهانه</b>\nهزینه‌ی یک روز (${(s.initial_charge ?? 0).toLocaleString("en-US")} تومان) برای تست کسر شد. اگر تا ۲۴ ساعت دیگر مشکلی گزارش نکنید (دکمه «⚠️ گزارش مشکل» در بخش سرویس‌های من)، مابقی مبلغ ماهانه (${((s.monthly_price ?? 0) - (s.initial_charge ?? 0)).toLocaleString("en-US")} تومان) کسر می‌شود.`
      : "";
  const d = s.detail;
  const specs = d
    ? `🖥 پلن: ${esc(d.plan)}\n⚙️ مشخصات: ${d.cpu} vCPU | ${d.ram_gb}GB RAM | ${d.disk_gb}GB دیسک\n` +
      (d.location ? `🌍 لوکیشن: ${esc(d.location)}\n` : "") +
      (d.os ? `💿 سیستم‌عامل: ${esc(d.os)}\n` : "") +
      (d.meta?.network ? `🌐 شبکه: ${esc(d.meta.network.toUpperCase())}\n` : "") +
      (d.meta?.bandwidth ? `📶 پهناباند: ${d.meta.bandwidth} مگابیت نامحدود\n` : "") +
      "\n"
    : "";
  return (
    `✅ <b>سرور #${s.id} ساخته شد</b>\n\n` +
    specs +
    `🌐 IP: <code>${esc(s.ip ?? "در حال تخصیص")}</code>\n` +
    `👤 یوزر: <code>${esc(s.login_user)}</code>\n` +
    `🔑 پسورد: <code>${esc(s.login_pass)}</code>\n\n` +
    `ℹ️ نصب سیستم‌عامل ممکن است تا چند دقیقه طول بکشد؛ اگر هنوز وصل نشد کمی صبر کنید.` +
    monthly
  );
}

/** سرویس را فعال می‌کند (فقط اگر هنوز provisioning باشد). true = فعال شد */
async function activate(api: Api, serviceId: number, res: ProvisionResult): Promise<boolean> {
  const row = await queryOne<Cred & { user_id: number; login_user: string; login_pass: string }>(
    `UPDATE services
        SET status='active', vps_id=$2, ip=$3, external_id=$4, dc_meta=dc_meta || COALESCE($5::jsonb, '{}'::jsonb), power='on', last_billed_at=now(), provision_error=NULL,
            trial = (billing_mode='monthly'),
            period_start = CASE WHEN billing_mode='monthly' THEN now() END,
            period_end   = CASE WHEN billing_mode='monthly' THEN now() + interval '24 hours' END
      WHERE id=$1 AND status='provisioning'
      RETURNING id, user_id, ip, login_user, login_pass, billing_mode, initial_charge, monthly_price`,
    [serviceId, res.vpsId, res.ip, res.externalId ?? null, res.meta ? JSON.stringify(res.meta) : null],
  );
  if (!row) return false;
  const d = await queryOne<{ plan: string; cpu: number; ram_gb: number; disk_gb: number; location: string | null; os: string | null; meta: Record<string, any> }>(
    `SELECT p.name AS plan, p.cpu, p.ram_gb, p.disk_gb, s.location, s.os, s.dc_meta AS meta FROM services s JOIN plans p ON p.id = s.plan_id WHERE s.id=$1`,
    [serviceId],
  );
  await tell(api, row.user_id, credentials({ ...row, detail: d ?? undefined }));
  void report(
    api,
    "servers",
    `🆕 <b>سرور جدید ساخته شد</b>\n🕒 ${stamp()}\n🖥 #${row.id} | 🌐 <code>${esc(row.ip ?? "در حال تخصیص")}</code> | ${row.billing_mode === "monthly" ? "ماهانه" : "ساعتی"}\n👤 کاربر: <code>${row.user_id}</code>`,
  );
  return true;
}

/** شکست قطعی: وضعیت failed + برگرداندن هزینه (فقط یک‌بار) */
async function refund(api: Api, serviceId: number, reason: string, hint?: string) {
  const r = await withTx(async (c) => {
    const s = (
      await c.query<{ user_id: number; amount: number }>(
        `UPDATE services SET status='failed', provision_error=$2
          WHERE id=$1 AND status='provisioning'
          RETURNING user_id, COALESCE(NULLIF(initial_charge,0), hourly_price) AS amount`,
        [serviceId, reason.slice(0, 500)],
      )
    ).rows[0];
    if (!s) return null;
    await c.query("UPDATE users SET balance = balance + $1 WHERE id=$2", [s.amount, s.user_id]);
    return s;
  });
  if (!r) return;
  void (async () =>
    report(
      api,
      "finance",
      `↩️ <b>بازگشت وجه (ساخت ناموفق)</b> — کد <code>${codes.refund(serviceId)}</code>\n🕒 ${stamp()}\n` +
        `🖥 سرور #${serviceId}\n💵 مبلغ: <b>${r.amount.toLocaleString("en-US")}</b> تومان\n${await payerInfo(r.user_id)}`,
    ))().catch(() => {});
  await tell(
    api,
    r.user_id,
    `❌ ساخت سرور #${serviceId} با خطا روبه‌رو شد و مبلغ <b>${r.amount.toLocaleString("en-US")}</b> تومان به حساب شما برگشت داده شد.${hint ? `\nℹ️ ${esc(hint)}` : ""}\nلطفاً دوباره تلاش کنید یا با پشتیبانی (${esc((await getSettings()).support)}) تماس بگیرید.`,
    false,
  );
}

/** اجرای ساخت در پس‌زمینه (بعد از کسر هزینه و ثبت سرویس) */
export async function startProvisioning(api: Api, serviceId: number): Promise<void> {
  try {
    const r = await provisionServer(serviceId);
    const ok = await activate(api, serviceId, r);
    if (!ok) {
      // در این فاصله سرویس لغو/برگشت خورده؛ VPS یتیم را پاک کن
      await removeOrphan(serviceId, r).catch((e) => console.error("orphan cleanup failed", serviceId, e));
    }
  } catch (e) {
    console.error("provisioning failed", serviceId, e);
    const msg = e instanceof Error ? e.message : String(e);
    const dcTitle = getDatacenter(datacenterOfError(e) ?? "")?.title;
    await tellAdmins(
      api,
      `⚠️ <b>خطا در ساخت سرور #${serviceId}</b>${dcTitle ? `\n🌐 دیتاسنتر: ${esc(dcTitle)}` : ""}\n<code>${esc(msg).slice(0, 600)}</code>`,
    );
    if (await isDefinitiveFailure(serviceId, e).catch(() => false)) {
      await refund(api, serviceId, msg, (e as { userHint?: string }).userHint);
    } else {
      // نتیجه نامشخص (timeout/قطع اتصال): ممکن است VPS ساخته شده باشد؛ recoverStuck بررسی می‌کند
      await query("UPDATE services SET provision_error=$2 WHERE id=$1", [serviceId, msg.slice(0, 500)]);
    }
  }
}

/** سرویس‌هایی که بیش از ۱۰ دقیقه در provisioning مانده‌اند: اگر روی پنل هستند فعال، وگرنه برگشت پول */
export async function recoverStuck(api: Api): Promise<void> {
  const stuck = await query<{ id: number; datacenter: string }>(
    `SELECT id, datacenter FROM services WHERE status='provisioning' AND created_at < now() - interval '10 minutes' ORDER BY id LIMIT 20`,
  );
  for (const { id, datacenter } of stuck) {
    // هر دیتاسنتر مستقل بازیابی می‌شود؛ دیتاسنترِ غیرقابل‌دسترس فقط خودش را عقب می‌اندازد
    const dc = getDatacenter(datacenter);
    if (!dc || !dc.implemented || !dc.isConfigured()) continue;
    try {
      const found = await findExisting(id);
      if (found) await activate(api, id, found);
      else await refund(api, id, "ساخت سرور کامل نشد (timeout)");
    } catch (e) {
      console.error("recoverStuck skipped", id, e instanceof Error ? e.message : e); // پنل در دسترس نیست؛ دور بعد
    }
  }
}

import type { Api } from "grammy";
import { config } from "./config";
import { query, queryOne, withTx } from "./db";
import { hostnameFor, provisionServer } from "./provider";
import * as V from "./virtualizor";

const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const WAIT_KB = { inline_keyboard: [[{ text: "📦 سرویس‌های من", callback_data: "services" }]] };

async function tell(api: Api, userId: number, text: string, kb = true) {
  await api
    .sendMessage(userId, text, { parse_mode: "HTML", ...(kb ? { reply_markup: WAIT_KB } : {}) })
    .catch(() => {});
}

async function tellAdmins(api: Api, text: string) {
  for (const id of config.admins) await api.sendMessage(id, text, { parse_mode: "HTML" }).catch(() => {});
}

function credentials(s: { id: number; ip: string | null; login_user: string | null; login_pass: string | null }) {
  return (
    `✅ <b>سرور #${s.id} ساخته شد</b>\n\n` +
    `🌐 IP: <code>${esc(s.ip ?? "در حال تخصیص")}</code>\n` +
    `👤 یوزر: <code>${esc(s.login_user)}</code>\n` +
    `🔑 پسورد: <code>${esc(s.login_pass)}</code>\n\n` +
    `ℹ️ نصب سیستم‌عامل ممکن است تا چند دقیقه طول بکشد؛ اگر هنوز وصل نشد کمی صبر کنید.`
  );
}

/** سرویس را فعال می‌کند (فقط اگر هنوز provisioning باشد). true = فعال شد */
async function activate(api: Api, serviceId: number, vpsId: number, ip: string | null): Promise<boolean> {
  const row = await queryOne<{ id: number; user_id: number; ip: string | null; login_user: string; login_pass: string }>(
    `UPDATE services
        SET status='active', vps_id=$2, ip=$3, power='on', last_billed_at=now(), provision_error=NULL
      WHERE id=$1 AND status='provisioning'
      RETURNING id, user_id, ip, login_user, login_pass`,
    [serviceId, vpsId, ip],
  );
  if (!row) return false;
  await tell(api, row.user_id, credentials(row));
  return true;
}

/** شکست قطعی: وضعیت failed + برگرداندن هزینه (فقط یک‌بار) */
async function refund(api: Api, serviceId: number, reason: string) {
  const r = await withTx(async (c) => {
    const s = (
      await c.query<{ user_id: number; hourly_price: number }>(
        `UPDATE services SET status='failed', provision_error=$2
          WHERE id=$1 AND status='provisioning' RETURNING user_id, hourly_price`,
        [serviceId, reason.slice(0, 500)],
      )
    ).rows[0];
    if (!s) return null;
    await c.query("UPDATE users SET balance = balance + $1 WHERE id=$2", [s.hourly_price, s.user_id]);
    return s;
  });
  if (!r) return;
  await tell(
    api,
    r.user_id,
    `❌ ساخت سرور #${serviceId} با خطا روبه‌رو شد و مبلغ <b>${r.hourly_price.toLocaleString("en-US")}</b> تومان به حساب شما برگشت داده شد.\nلطفاً دوباره تلاش کنید یا با پشتیبانی (${esc(config.support)}) تماس بگیرید.`,
    false,
  );
}

/** اجرای ساخت در پس‌زمینه (بعد از کسر هزینه و ثبت سرویس) */
export async function startProvisioning(api: Api, serviceId: number): Promise<void> {
  try {
    const r = await provisionServer(serviceId);
    const ok = await activate(api, serviceId, r.vpsId, r.ip);
    if (!ok) {
      // در این فاصله سرویس لغو/برگشت خورده؛ VPS یتیم را پاک کن
      await V.deleteVps(r.vpsId).catch((e) => console.error("orphan cleanup failed", serviceId, e));
    }
  } catch (e) {
    console.error("provisioning failed", serviceId, e);
    const msg = e instanceof Error ? e.message : String(e);
    await tellAdmins(api, `⚠️ <b>خطا در ساخت سرور #${serviceId}</b>\n<code>${esc(msg).slice(0, 600)}</code>`);
    if (e instanceof V.VirtError && e.kind === "panel") {
      await refund(api, serviceId, msg);
    } else {
      // نتیجه نامشخص (timeout/قطع اتصال): ممکن است VPS ساخته شده باشد؛ recoverStuck بررسی می‌کند
      await query("UPDATE services SET provision_error=$2 WHERE id=$1", [serviceId, msg.slice(0, 500)]);
    }
  }
}

/** سرویس‌هایی که بیش از ۱۰ دقیقه در provisioning مانده‌اند: اگر روی پنل هستند فعال، وگرنه برگشت پول */
export async function recoverStuck(api: Api): Promise<void> {
  if (!V.isConfigured()) return;
  const stuck = await query<{ id: number }>(
    `SELECT id FROM services WHERE status='provisioning' AND created_at < now() - interval '10 minutes' ORDER BY id LIMIT 20`,
  );
  for (const { id } of stuck) {
    try {
      const vps = await V.findByHostname(hostnameFor(id));
      if (vps) await activate(api, id, vps.vpsid, vps.ips[0] ?? null);
      else await refund(api, id, "ساخت سرور کامل نشد (timeout)");
    } catch (e) {
      console.error("recoverStuck skipped", id, e instanceof Error ? e.message : e); // پنل در دسترس نیست؛ دور بعد
    }
  }
}

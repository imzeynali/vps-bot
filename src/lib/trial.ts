import type { Api } from "grammy";
import { config } from "./config";
import { queryOne, withTx } from "./db";
import { deleteServer } from "./provider";

const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const n = (x: number) => x.toLocaleString("en-US");

async function tellAdmins(api: Api, text: string, serviceId?: number) {
  for (const id of config.admins) {
    await api
      .sendMessage(id, text, {
        parse_mode: "HTML",
        ...(serviceId
          ? {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "✅ مشکل رفع شد؛ ادامه تمدید", callback_data: `adm:tok:${serviceId}` },
                    { text: "🗑 لغو و بازگشت وجه", callback_data: `adm:tx:${serviceId}` },
                  ],
                ],
              },
            }
          : {}),
      })
      .catch(() => {});
  }
}

/** کاربر در دوره‌ی تست «مشکل» گزارش می‌کند؛ تا بررسی ادمین مبلغ دیگری کسر نمی‌شود */
export async function reportProblem(api: Api, userId: number, serviceId: number): Promise<"ok" | "already" | "invalid"> {
  const s = await queryOne<{ id: number; ip: string | null; plan_name: string; username: string | null; initial_charge: number }>(
    `UPDATE services s SET trial_issue = TRUE
       FROM plans p, users u
      WHERE s.id=$1 AND s.user_id=$2 AND s.status='active' AND s.billing_mode='monthly' AND s.trial AND NOT s.trial_issue
        AND p.id = s.plan_id AND u.id = s.user_id
      RETURNING s.id, s.ip, p.name AS plan_name, u.username, s.initial_charge`,
    [serviceId, userId],
  );
  if (!s) {
    const ex = await queryOne<{ trial_issue: boolean }>(
      "SELECT trial_issue FROM services WHERE id=$1 AND user_id=$2 AND billing_mode='monthly' AND trial",
      [serviceId, userId],
    );
    return ex?.trial_issue ? "already" : "invalid";
  }
  await tellAdmins(
    api,
    `⚠️ <b>گزارش مشکل در دوره‌ی تست</b>\n\n🖥 سرور #${s.id} (${esc(s.plan_name)})\n🌐 IP: <code>${esc(s.ip)}</code>\n` +
      `👤 کاربر: <code>${userId}</code>${s.username ? " @" + esc(s.username) : ""}\n\n` +
      `تا تعیین تکلیف، مابقی مبلغ ماهانه کسر نمی‌شود.`,
    s.id,
  );
  return "ok";
}

/** ادمین: مشکل رفع شد؛ در اولین اجرای صورتحساب مابقی مبلغ کسر می‌شود */
export async function approveTrial(api: Api, serviceId: number): Promise<boolean> {
  const r = await queryOne<{ user_id: number }>(
    `UPDATE services SET trial_issue=FALSE, period_end=now()
      WHERE id=$1 AND status='active' AND billing_mode='monthly' AND trial RETURNING user_id`,
    [serviceId],
  );
  if (!r) return false;
  await api
    .sendMessage(r.user_id, `✅ مشکل سرور #${serviceId} بررسی شد. دوره‌ی تست به پایان می‌رسد و سرویس ماهانه ادامه پیدا می‌کند.`)
    .catch(() => {});
  return true;
}

/** ادمین: حذف سرور از پنل + بازگشت هزینه‌ی روز تست */
export async function cancelTrial(api: Api, serviceId: number): Promise<{ ok: boolean; msg: string }> {
  const s = await queryOne<{ id: number }>(
    "SELECT id FROM services WHERE id=$1 AND status IN ('active','suspended') AND billing_mode='monthly' AND trial",
    [serviceId],
  );
  if (!s) return { ok: false, msg: "سرویس تست‌شده پیدا نشد (شاید قبلاً بسته شده)." };
  try {
    await deleteServer(serviceId);
  } catch (e) {
    return { ok: false, msg: "حذف از پنل انجام نشد: " + (e instanceof Error ? e.message : "خطا") };
  }
  const r = await withTx(async (c) => {
    const x = (
      await c.query<{ user_id: number; initial_charge: number }>(
        `UPDATE services SET status='deleted', deleted_at=now()
          WHERE id=$1 AND status IN ('active','suspended') RETURNING user_id, initial_charge`,
        [serviceId],
      )
    ).rows[0];
    if (!x) return null;
    await c.query("UPDATE users SET balance = balance + $1 WHERE id=$2", [x.initial_charge, x.user_id]);
    return x;
  });
  if (!r) return { ok: false, msg: "قبلاً بسته شده است." };
  await api
    .sendMessage(r.user_id, `↩️ سرور #${serviceId} لغو شد و مبلغ ${n(r.initial_charge)} تومان به حساب شما برگشت داده شد.`)
    .catch(() => {});
  return { ok: true, msg: `لغو شد و ${n(r.initial_charge)} تومان برگشت داده شد.` };
}


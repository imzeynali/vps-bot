import type { Api } from "grammy";
import { query, withTx } from "./db";
import { powerAction } from "./provider";
import { recoverStuck } from "./provisioning";

const n = (x: number) => x.toLocaleString("en-US");
const TZ = "Asia/Tehran";
const jdate = (d: Date) => new Date(d).toLocaleDateString("fa-IR", { timeZone: TZ });

type BillResult =
  | { kind: "skip" }
  | { kind: "charged"; userId: number; low: boolean; serviceId: number }
  | { kind: "suspended"; userId: number; serviceId: number }
  | { kind: "m_charged"; userId: number; serviceId: number; amount: number; wasTrial: boolean; nextEnd: Date }
  | { kind: "m_suspended"; userId: number; serviceId: number; amount: number };

// ───────────── ساعتی ─────────────
async function billService(id: number): Promise<BillResult> {
  return withTx<BillResult>(async (c) => {
    // SKIP LOCKED: اگر دو اجرای همزمان cron داشتیم، یک سرویس دوبار کسر نشود
    const s = (
      await c.query<{ id: number; user_id: number; hourly_price: number }>(
        `SELECT id, user_id, hourly_price FROM services
         WHERE id=$1 AND status='active' AND billing_mode='hourly' AND last_billed_at <= now() - interval '1 hour'
         FOR UPDATE SKIP LOCKED`,
        [id],
      )
    ).rows[0];
    if (!s) return { kind: "skip" };

    const bal = (await c.query<{ balance: number }>("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [s.user_id]))
      .rows[0].balance;

    if (bal >= s.hourly_price) {
      await c.query("UPDATE users SET balance = balance - $1 WHERE id=$2", [s.hourly_price, s.user_id]);
      await c.query("UPDATE services SET last_billed_at = last_billed_at + interval '1 hour' WHERE id=$1", [s.id]);
      return {
        kind: "charged",
        userId: s.user_id,
        serviceId: s.id,
        low: bal - s.hourly_price < s.hourly_price * 3,
      };
    }
    await c.query("UPDATE services SET status='suspended', power='off' WHERE id=$1", [s.id]);
    return { kind: "suspended", userId: s.user_id, serviceId: s.id };
  });
}

// ───────────── ماهانه (۱ روز تست ← مابقی ← تمدید هر ۳۰ روز) ─────────────
async function billMonthly(id: number): Promise<BillResult> {
  return withTx<BillResult>(async (c) => {
    const s = (
      await c.query<{
        id: number;
        user_id: number;
        monthly_price: number;
        initial_charge: number;
        trial: boolean;
        trial_issue: boolean;
      }>(
        `SELECT id, user_id, monthly_price, initial_charge, trial, trial_issue FROM services
          WHERE id=$1 AND status='active' AND billing_mode='monthly' AND period_end <= now()
          FOR UPDATE SKIP LOCKED`,
        [id],
      )
    ).rows[0];
    if (!s) return { kind: "skip" };
    if (s.trial && s.trial_issue) return { kind: "skip" }; // منتظر تصمیم ادمین

    // در پایان تست: مابقی مبلغ ماهانه؛ در تمدید: کل مبلغ ماهانه
    const amount = s.trial ? Math.max(s.monthly_price - s.initial_charge, 0) : s.monthly_price;
    const bal = (await c.query<{ balance: number }>("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [s.user_id]))
      .rows[0].balance;

    if (bal >= amount) {
      await c.query("UPDATE users SET balance = balance - $1 WHERE id=$2", [amount, s.user_id]);
      const r = (
        await c.query<{ period_end: Date }>(
          s.trial
            ? `UPDATE services SET trial=FALSE, warned=FALSE, period_end = period_start + interval '30 days'
                WHERE id=$1 RETURNING period_end`
            : `UPDATE services SET warned=FALSE, period_start = period_end, period_end = period_end + interval '30 days'
                WHERE id=$1 RETURNING period_end`,
          [s.id],
        )
      ).rows[0];
      return { kind: "m_charged", userId: s.user_id, serviceId: s.id, amount, wasTrial: s.trial, nextEnd: r.period_end };
    }
    await c.query("UPDATE services SET status='suspended', power='off' WHERE id=$1", [s.id]);
    return { kind: "m_suspended", userId: s.user_id, serviceId: s.id, amount };
  });
}

/** هشدار پیش از کسر ماهانه (تا ۶ ساعت قبل) اگر موجودی کافی نباشد؛ فقط یک‌بار */
async function warnUpcoming(api: Api) {
  const rows = await query<{
    id: number;
    user_id: number;
    amount: number;
    balance: number;
    period_end: Date;
  }>(
    `SELECT s.id, s.user_id, u.balance, s.period_end,
            CASE WHEN s.trial THEN GREATEST(s.monthly_price - s.initial_charge, 0) ELSE s.monthly_price END AS amount
       FROM services s JOIN users u ON u.id = s.user_id
      WHERE s.status='active' AND s.billing_mode='monthly' AND NOT s.warned
        AND s.period_end > now() AND s.period_end <= now() + interval '6 hours'
        AND NOT (s.trial AND s.trial_issue)`,
  );
  for (const r of rows) {
    if (r.balance >= r.amount) continue;
    const ok = await query("UPDATE services SET warned=TRUE WHERE id=$1 AND NOT warned RETURNING id", [r.id]);
    if (!ok.length) continue;
    await api
      .sendMessage(
        r.user_id,
        `⚠️ تا چند ساعت دیگر مبلغ ${n(r.amount)} تومان بابت سرویس ماهانه #${r.id} از حساب شما کسر می‌شود، ولی موجودی شما ${n(r.balance)} تومان است. لطفاً حساب را شارژ کنید تا سرور متوقف نشود.`,
      )
      .catch(() => {});
  }
}

export async function runBilling(api: Api) {
  await recoverStuck(api).catch((e) => console.error("recoverStuck error", e));
  await warnUpcoming(api).catch((e) => console.error("warnUpcoming error", e));

  const due = await query<{ id: number; mode: string }>(
    `SELECT id, billing_mode AS mode FROM services
     WHERE status='active' AND (
            (billing_mode='hourly'  AND last_billed_at <= now() - interval '1 hour')
         OR (billing_mode='monthly' AND period_end <= now() AND NOT (trial AND trial_issue)))
     ORDER BY id LIMIT 500`,
  );
  let charged = 0;
  let suspended = 0;

  for (const { id, mode } of due) {
    try {
      const r = mode === "monthly" ? await billMonthly(id) : await billService(id);
      if (r.kind === "charged") {
        charged++;
        if (r.low) {
          await api
            .sendMessage(r.userId, `⚠️ موجودی شما کمتر از ۳ ساعت مصرف سرور #${r.serviceId} است. لطفاً حساب را شارژ کنید.`)
            .catch(() => {});
        }
      } else if (r.kind === "m_charged") {
        charged++;
        await api
          .sendMessage(
            r.userId,
            r.wasTrial
              ? `✅ دوره‌ی تست سرور #${r.serviceId} تمام شد و مابقی هزینه‌ی ماهانه (${n(r.amount)} تومان) از حساب شما کسر شد.\n🔁 تمدید بعدی: ${jdate(r.nextEnd)}`
              : `🔁 سرویس ماهانه #${r.serviceId} تمدید شد؛ ${n(r.amount)} تومان کسر شد.\nتمدید بعدی: ${jdate(r.nextEnd)}`,
          )
          .catch(() => {});
      } else if (r.kind === "suspended" || r.kind === "m_suspended") {
        suspended++;
        await powerAction(r.serviceId, "off").catch(() => {});
        await api
          .sendMessage(r.userId, `🔴 به دلیل کمبود موجودی، سرور #${r.serviceId} خاموش و متوقف شد.`)
          .catch(() => {});
      }
    } catch (e) {
      console.error("billing error for service", id, e);
    }
  }
  return { due: due.length, charged, suspended };
}

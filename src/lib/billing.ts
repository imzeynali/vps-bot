import type { Api } from "grammy";
import { query, withTx } from "./db";
import { powerAction } from "./provider";
import { recoverStuck } from "./provisioning";

type BillResult =
  | { kind: "skip" }
  | { kind: "charged"; userId: number; low: boolean; serviceId: number }
  | { kind: "suspended"; userId: number; serviceId: number };

async function billService(id: number): Promise<BillResult> {
  return withTx<BillResult>(async (c) => {
    // SKIP LOCKED: اگر دو اجرای همزمان cron داشتیم، یک سرویس دوبار کسر نشود
    const s = (
      await c.query<{ id: number; user_id: number; hourly_price: number }>(
        `SELECT id, user_id, hourly_price FROM services
         WHERE id=$1 AND status='active' AND last_billed_at <= now() - interval '1 hour'
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

export async function runBilling(api: Api) {
  await recoverStuck(api).catch((e) => console.error("recoverStuck error", e));
  const due = await query<{ id: number }>(
    `SELECT id FROM services
     WHERE status='active' AND last_billed_at <= now() - interval '1 hour'
     ORDER BY last_billed_at LIMIT 500`,
  );
  let charged = 0;
  let suspended = 0;

  for (const { id } of due) {
    try {
      const r = await billService(id);
      if (r.kind === "charged") {
        charged++;
        if (r.low) {
          await api
            .sendMessage(r.userId, `⚠️ موجودی شما کمتر از ۳ ساعت مصرف سرور #${r.serviceId} است. لطفاً حساب را شارژ کنید.`)
            .catch(() => {});
        }
      } else if (r.kind === "suspended") {
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

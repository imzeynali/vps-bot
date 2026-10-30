import { config } from "./config";
import { withTx } from "./db";
import { genPassword } from "./provider";
import type { Plan } from "./types";

export type BillingMode = "hourly" | "monthly";

/** هزینه‌ی یک روز از قیمت ماهانه (دوره‌ی تست سرویس ماهانه) */
export const dayCost = (monthly: number) => Math.ceil(monthly / 30);

const n = (x: number) => x.toLocaleString("en-US");

export type PurchaseResult = { sid: number; charged: number } | { error: string };

/**
 * کسر هزینه‌ی اولیه + ثبت سرویس (status=provisioning) در یک تراکنش.
 *  - ساعتی:  یک ساعت از موجودی کسر می‌شود و صورتحساب ساعتی ادامه دارد
 *  - ماهانه: هزینه‌ی «یک روز» (قیمت ماهانه ÷ ۳۰) برای تست کسر می‌شود؛ بعد از ۲۴ ساعت اگر مشکلی گزارش نشود،
 *            مابقی قیمت ماهانه کسر می‌شود (billing.ts) و سپس هر ۳۰ روز تمدید می‌شود.
 */
export async function purchaseService(i: {
  userId: number;
  planId: number;
  locKey: string;
  osKey: string;
  mode: BillingMode;
}): Promise<PurchaseResult> {
  return withTx<PurchaseResult>(async (c) => {
    const p = (await c.query<Plan>("SELECT * FROM plans WHERE id=$1 AND active", [i.planId])).rows[0];
    const loc = (await c.query<{ key: string; title: string }>("SELECT key, title FROM locations WHERE key=$1 AND active", [i.locKey])).rows[0];
    const os = (await c.query<{ key: string; name: string }>("SELECT key, name FROM os_templates WHERE key=$1 AND active", [i.osKey])).rows[0];
    const u = (await c.query<{ balance: number }>("SELECT balance FROM users WHERE id=$1 FOR UPDATE", [i.userId])).rows[0];
    if (!p || !loc || !os || !u) return { error: "❌ خطا در ثبت سفارش" };

    let charge = p.hourly_price;
    if (i.mode === "monthly") {
      if (!p.monthly_price || p.monthly_price <= 0) return { error: "❌ خرید ماهانه برای این پلن فعال نیست." };
      charge = dayCost(p.monthly_price);
    }
    if (u.balance < Math.max(config.minBalanceToBuy, charge)) {
      return {
        error: `❌ موجودی شما کم است. حداقل موجودی برای ساخت سرویس ${n(Math.max(config.minBalanceToBuy, charge))} تومان است.`,
      };
    }

    await c.query("UPDATE users SET balance = balance - $1 WHERE id=$2", [charge, i.userId]);
    const sid = (
      await c.query<{ id: number }>(
        `INSERT INTO services (user_id, plan_id, hourly_price, location, os, location_key, os_key,
                               status, login_user, login_pass, panel_pass, billing_mode, monthly_price, initial_charge)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'provisioning','root',$8,$9,$10,$11,$12) RETURNING id`,
        [
          i.userId, p.id, p.hourly_price, loc.title, os.name, loc.key, os.key,
          genPassword(), genPassword(),
          i.mode, i.mode === "monthly" ? p.monthly_price : null, charge,
        ],
      )
    ).rows[0].id;
    return { sid, charged: charge };
  });
}

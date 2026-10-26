import { InlineKeyboard } from "grammy";
import { config } from "@/lib/config";

/** اگر userId ادمین باشد، دکمه «پنل مدیریت» هم اضافه می‌شود */
export function mainMenu(userId?: number) {
  const kb = new InlineKeyboard()
    .text("🛒 خرید سرویس", "buy")
    .text("📦 سرویس‌های من", "services")
    .row()
    .text("👤 حساب کاربری", "account")
    .text("💳 شارژ حساب", "topup")
    .row()
    .text("🆘 تماس با پشتیبانی", "support")
    .text("📜 شرایط و ضوابط", "terms")
    .row()
    .text("💰 درآمدزایی", "referral");
  if (userId !== undefined && config.admins.includes(userId)) kb.row().text("🛠 پنل مدیریت", "admin");
  return kb;
}

/** دکمه‌های اضافه (هرکدام در یک ردیف) + «منوی اصلی» */
export function backKb(extra: [text: string, data: string][] = []) {
  const kb = new InlineKeyboard();
  for (const [text, data] of extra) kb.text(text, data).row();
  return kb.text("🔙 منوی اصلی", "home");
}

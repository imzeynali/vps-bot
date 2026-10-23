import { InlineKeyboard } from "grammy";

export const mainMenu = () =>
  new InlineKeyboard()
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

/** دکمه‌های اضافه (هرکدام در یک ردیف) + «منوی اصلی» */
export function backKb(extra: [text: string, data: string][] = []) {
  const kb = new InlineKeyboard();
  for (const [text, data] of extra) kb.text(text, data).row();
  return kb.text("🔙 منوی اصلی", "home");
}

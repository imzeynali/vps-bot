async function main() {
  const { BOT_TOKEN, APP_URL, WEBHOOK_SECRET } = process.env;
  if (!BOT_TOKEN || !APP_URL) throw new Error("BOT_TOKEN و APP_URL را تنظیم کنید");
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: `${APP_URL.replace(/\/$/, "")}/api/telegram`,
      secret_token: WEBHOOK_SECRET || undefined,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    }),
  });
  console.log(await res.json());
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});

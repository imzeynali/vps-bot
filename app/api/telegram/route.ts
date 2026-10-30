import { webhookCallback } from "grammy";
import { getBot } from "@/bot";
import { config } from "@/lib/config";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

let handler: ((req: Request) => Promise<Response>) | null = null;

export async function POST(req: Request): Promise<Response> {
  if (!handler) {
    handler = webhookCallback(getBot(), "std/http", {
      secretToken: config.webhookSecret || undefined,
      // عملیات پنل ممکن است طولانی شود؛ پس از ۸ ثانیه ۲۰۰ برگردان تا تلگرام آپدیت را دوباره نفرستد
      timeoutMilliseconds: 8000,
      onTimeout: "return",
    });
  }
  return handler(req);
}

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
    });
  }
  return handler(req);
}

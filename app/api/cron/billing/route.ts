import { NextResponse } from "next/server";
import { getBot } from "@/bot";
import { config } from "@/lib/config";
import { runBilling } from "@/lib/billing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function handle(req: Request) {
  const auth = req.headers.get("authorization");
  if (!config.cronSecret || auth !== `Bearer ${config.cronSecret}`) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }
  const result = await runBilling(getBot().api);
  return NextResponse.json({ ok: true, ...result });
}

export const GET = handle;
export const POST = handle;

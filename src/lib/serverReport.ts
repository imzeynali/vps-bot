import type { Api } from "grammy";
import net from "node:net";
import { query, queryOne } from "./db";
import * as V from "./virtualizor";
import { delKV, esc, fmtN, getGroup, report, stamp } from "./adminGroup";

const MAX_PROBE = 40; // سقف سرورهای بررسی‌شده در هر گزارش (محدودیت سرویس‌های بیرونی)
const g = globalThis as unknown as { __srvReporting?: boolean; __irNodes?: { at: number; nodes: string[] } };

interface Svc {
  id: number;
  ip: string | null;
  vps_id: number | null;
  power: string;
}
type Ping = "up" | "down" | "unknown";

// ───────────────────────── بررسی سلامت (TCP از سرور ربات) ─────────────────────────
/** سالم = IP پاسخ دهد (اتصال برقرار شود یا رد شود؛ هر دو یعنی هاست بالاست). timeout/unreachable = ناسالم */
function tcpProbe(ip: string, port = 22, ms = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port });
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED"));
  });
}

// ───────────────────────── دسترسی از ایران (check-host.net) ─────────────────────────
async function irNodes(): Promise<string[]> {
  if (g.__irNodes && Date.now() - g.__irNodes.at < 3600_000) return g.__irNodes.nodes;
  const r = await fetch("https://check-host.net/nodes/hosts", { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
  const j = (await r.json()) as { nodes?: Record<string, { location?: string[] }> };
  const nodes = Object.entries(j.nodes ?? {})
    .filter(([, v]) => v.location?.[0]?.toLowerCase() === "ir")
    .map(([k]) => k)
    .slice(0, 4);
  g.__irNodes = { at: Date.now(), nodes };
  return nodes;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** پینگ از نودهای ایران؛ up = حداقل یک نود ایرانی پاسخ گرفت */
async function irPing(ip: string): Promise<Ping> {
  try {
    const nodes = await irNodes();
    if (!nodes.length) return "unknown";
    const qs = nodes.map((n) => `node=${encodeURIComponent(n)}`).join("&");
    const start = await fetch(`https://check-host.net/check-ping?host=${encodeURIComponent(ip)}&${qs}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const s = (await start.json()) as { ok?: number; request_id?: string };
    if (!s.ok || !s.request_id) return "unknown";
    for (let i = 0; i < 4; i++) {
      await sleep(i === 0 ? 5000 : 3000);
      const res = await fetch(`https://check-host.net/check-result/${s.request_id}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      const j = (await res.json()) as Record<string, unknown>;
      const vals = nodes.map((n) => j[n]);
      if (vals.some((v) => v === null || v === undefined) && i < 3) continue; // هنوز در حال بررسی
      let anyData = false;
      for (const v of vals) {
        const rows = Array.isArray(v) ? (v[0] as unknown) : null;
        if (!Array.isArray(rows)) continue;
        anyData = true;
        if (rows.some((x) => Array.isArray(x) && x[0] === "OK")) return "up";
      }
      return anyData ? "down" : "unknown";
    }
    return "unknown";
  } catch {
    return "unknown";
  }
}

async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

// ───────────────────────── ساخت گزارش ─────────────────────────
export async function buildServerReport(): Promise<{ text: string; problems: string[] }> {
  const c = await queryOne<Record<string, number>>(
    `SELECT
       count(*) FILTER (WHERE status='active')::int AS active,
       count(*) FILTER (WHERE status='active' AND power='on')::int AS on_,
       count(*) FILTER (WHERE status='active' AND power='off')::int AS off_,
       count(*) FILTER (WHERE status='suspended')::int AS suspended,
       count(*) FILTER (WHERE status='deleted')::int AS deleted,
       count(*) FILTER (WHERE status='failed')::int AS failed,
       count(*) FILTER (WHERE status='provisioning')::int AS prov
     FROM services`,
  );

  const svcs = await query<Svc>(
    `SELECT id, ip, vps_id, power FROM services WHERE status='active' AND ip IS NOT NULL ORDER BY id LIMIT ${MAX_PROBE + 1}`,
  );
  const truncated = svcs.length > MAX_PROBE;
  const list = svcs.slice(0, MAX_PROBE);

  // وضعیت از دید پنل Virtualizor
  let panelOk = true;
  const panelRunning = new Map<number, boolean>();
  if (V.isConfigured()) {
    try {
      for (const v of await V.listVps()) {
        const st = (v.raw as Record<string, unknown>).status;
        if (st !== undefined) panelRunning.set(v.vpsid, Number(st) === 1);
      }
    } catch {
      panelOk = false;
    }
  } else panelOk = false;

  const tcp = await pool(list, 8, (s) => tcpProbe(s.ip!));
  const ir = await pool(list, 4, (s) => irPing(s.ip!));

  let healthy = 0;
  let unhealthy = 0;
  let irUp = 0;
  let irDown = 0;
  let irUnknown = 0;
  const problems: string[] = [];
  list.forEach((s, i) => {
    const poweredOff = s.power === "off" || panelRunning.get(s.vps_id ?? -1) === false;
    const ok = tcp[i] && !poweredOff;
    if (ok) healthy++;
    else {
      unhealthy++;
      problems.push(`#${s.id} <code>${esc(s.ip)}</code> — ${poweredOff ? "خاموش" : "بدون پاسخ"}`);
    }
    if (ir[i] === "up") irUp++;
    else if (ir[i] === "down") {
      irDown++;
      problems.push(`#${s.id} <code>${esc(s.ip)}</code> — عدم دسترسی از ایران`);
    } else irUnknown++;
  });

  const text =
    `🖥 <b>گزارش وضعیت سرورها</b>\n🕒 ${stamp()}\n\n` +
    `🟢 <b>سرورهای فعال:</b> ${fmtN(c?.active ?? 0)} (روشن: ${fmtN(c?.on_ ?? 0)} | خاموش: ${fmtN(c?.off_ ?? 0)})\n` +
    `🔴 <b>سرورهای غیرفعال:</b> ${fmtN((c?.suspended ?? 0) + (c?.deleted ?? 0) + (c?.failed ?? 0))}\n` +
    `    ⏸ متوقف‌شده (کمبود موجودی): ${fmtN(c?.suspended ?? 0)}\n` +
    `    🗑 حذف‌شده: ${fmtN(c?.deleted ?? 0)}\n` +
    `    ❌ ساخت ناموفق: ${fmtN(c?.failed ?? 0)}\n` +
    `⏳ در حال ساخت: ${fmtN(c?.prov ?? 0)}\n\n` +
    `🩺 <b>سلامت سرورها</b> (از ${fmtN(list.length)} سرور فعال دارای IP)\n` +
    `✅ سالم: <b>${fmtN(healthy)}</b>\n⚠️ ناسالم: <b>${fmtN(unhealthy)}</b>\n\n` +
    `🇮🇷 <b>دسترسی از ایران</b>\n` +
    `✅ قابل‌دسترس: <b>${fmtN(irUp)}</b>\n⛔️ غیرقابل‌دسترس: <b>${fmtN(irDown)}</b>\n❔ نامشخص: ${fmtN(irUnknown)}\n` +
    (panelOk ? "" : `\n⚠️ ارتباط با پنل Virtualizor برقرار نشد؛ وضعیت روشن/خاموش فقط از دیتابیس است.`) +
    (truncated ? `\nℹ️ فقط ${MAX_PROBE} سرور اول بررسی شد.` : "") +
    (problems.length ? `\n\n<b>موارد نیازمند بررسی:</b>\n${problems.slice(0, 15).join("\n")}` : "");

  return { text, problems };
}

/** ارسال گزارش به تاپیک «سرورها»؛ مشکلات جدید به تاپیک «خطا» هم می‌روند */
export async function sendServerReport(api: Api): Promise<boolean> {
  if (g.__srvReporting) return false;
  g.__srvReporting = true;
  try {
    const { text, problems } = await buildServerReport();
    const sent = await report(api, "servers", text);
    const sig = problems.join("|");
    const prev = await queryOne<{ value: string }>("SELECT value FROM settings WHERE key='grp_last_problems'");
    if (sig && sig !== prev?.value) {
      await report(api, "errors", `🚨 <b>مشکل در سرورها</b>\n🕒 ${stamp()}\n\n${problems.slice(0, 20).join("\n")}`);
    }
    if (sig) await query("INSERT INTO settings (key,value) VALUES ('grp_last_problems',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [sig]);
    else await delKV(["grp_last_problems"]);
    return sent;
  } finally {
    g.__srvReporting = false;
  }
}

/** از cron صدا زده می‌شود؛ هر N ساعت (پیش‌فرض ۶) یک‌بار، بدون مسدود کردن cron */
export async function maybeSendServerReport(api: Api, everyHours = 6) {
  if (!(await getGroup()).chatId) return; // گروه تنظیم نشده
  const now = Date.now();
  const claimed = await queryOne(
    `INSERT INTO settings (key, value) VALUES ('grp_last_servers_report', $1)
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value
       WHERE settings.value ~ '^[0-9]+$' AND settings.value::bigint < $2
     RETURNING key`,
    [String(now), now - everyHours * 3600_000],
  );
  if (!claimed) return;
  void sendServerReport(api).catch((e) => console.error("server report failed", e));
}

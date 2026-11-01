import type { Api } from "grammy";
import { config } from "./config";
import { query, queryOne } from "./db";

/**
 * گروه مدیریتی (سوپرگروه با تاپیک): گزارش‌های مالی، سرورها، خطاها و پیگیری کاربران.
 * تنظیمات در جدول settings ذخیره می‌شود (بدون نیاز به تغییر schema).
 */
export type Topic = "finance" | "servers" | "errors" | "followup";

export const TOPICS: Record<Topic, { key: string; title: string; icon: string }> = {
  finance: { key: "grp_topic_finance", title: "مالی", icon: "💰" },
  servers: { key: "grp_topic_servers", title: "سرورها", icon: "🖥" },
  errors: { key: "grp_topic_errors", title: "خطا", icon: "🚨" },
  followup: { key: "grp_topic_followup", title: "پیگیری", icon: "📨" },
};
const GROUP_KEY = "grp_chat_id";
const TOPIC_NAMES = Object.keys(TOPICS) as Topic[];

export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
export const fmtN = (x: number) => Number(x).toLocaleString("en-US");

async function getKV(keys: string[]): Promise<Map<string, string>> {
  const rows = await query<{ key: string; value: string }>("SELECT key, value FROM settings WHERE key = ANY($1)", [keys]);
  return new Map(rows.map((r) => [r.key, r.value]));
}
async function setKV(key: string, value: string) {
  await query("INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [key, value]);
}
export async function delKV(keys: string[]) {
  await query("DELETE FROM settings WHERE key = ANY($1)", [keys]);
}

export interface GroupConfig {
  chatId: number | null;
  topics: Partial<Record<Topic, number>>;
}

export async function getGroup(): Promise<GroupConfig> {
  const m = await getKV([GROUP_KEY, ...TOPIC_NAMES.map((t) => TOPICS[t].key)]);
  const chatId = m.has(GROUP_KEY) ? Number(m.get(GROUP_KEY)) : null;
  const topics: GroupConfig["topics"] = {};
  for (const t of TOPIC_NAMES) {
    const v = m.get(TOPICS[t].key);
    if (v && Number.isFinite(Number(v))) topics[t] = Number(v);
  }
  return { chatId: chatId && Number.isFinite(chatId) ? chatId : null, topics };
}

export async function disconnectGroup() {
  await delKV([GROUP_KEY, ...TOPIC_NAMES.map((t) => TOPICS[t].key)]);
}

/** ساخت تاپیک‌ها در گروه و ذخیره‌ی تنظیمات. در صورت خطا پیام فارسی قابل‌فهم برمی‌گرداند. */
export async function setupGroup(api: Api, chatId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const chat = await api.getChat(chatId);
    if (chat.type !== "supergroup") return { ok: false, error: "این چت «سوپرگروه» نیست. گروه را به سوپرگروه تبدیل کنید." };
    if (!("is_forum" in chat) || !chat.is_forum) {
      return { ok: false, error: "قابلیت «Topics» (تاپیک) در گروه روشن نیست. تنظیمات گروه ← Topics را فعال کنید." };
    }
    const me = await api.getChatMember(chatId, (await api.getMe()).id);
    const canManage = me.status === "creator" || (me.status === "administrator" && me.can_manage_topics);
    if (!canManage) return { ok: false, error: "ربات باید «ادمین» باشد و دسترسی «Manage Topics» (مدیریت تاپیک‌ها) داشته باشد." };
  } catch (e) {
    return { ok: false, error: "دسترسی به گروه ممکن نیست: " + errText(e) };
  }

  // اگر قبلاً همین گروه ست شده، تاپیک‌های موجود را دوباره نساز
  const cur = await getGroup();
  const keep = cur.chatId === chatId ? cur.topics : {};
  try {
    for (const t of TOPIC_NAMES) {
      if (keep[t]) continue;
      const created = await api.createForumTopic(chatId, `${TOPICS[t].icon} ${TOPICS[t].title}`);
      await setKV(TOPICS[t].key, String(created.message_thread_id));
    }
    await setKV(GROUP_KEY, String(chatId));
  } catch (e) {
    return { ok: false, error: "ساخت تاپیک انجام نشد: " + errText(e) };
  }
  return { ok: true };
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 200);

/**
 * ارسال به تاپیک. هرگز خطا پرتاب نمی‌کند (گزارش‌دهی نباید جریان اصلی را خراب کند).
 * اگر تاپیک پاک شده باشد، یک‌بار دوباره ساخته می‌شود.
 * برمی‌گرداند true = در گروه ارسال شد؛ false = گروه تنظیم نیست یا ارسال نشد.
 */
export async function report(api: Api, topic: Topic, html: string, extra: Record<string, unknown> = {}): Promise<boolean> {
  try {
    const g = await getGroup();
    if (!g.chatId) return false;
    const send = (thread: number) =>
      api.sendMessage(g.chatId!, html.slice(0, 4000), {
        parse_mode: "HTML",
        message_thread_id: thread,
        link_preview_options: { is_disabled: true },
        ...extra,
      });
    let thread = g.topics[topic];
    if (!thread) thread = await recreateTopic(api, g.chatId, topic);
    try {
      await send(thread);
    } catch (e) {
      if (/thread not found|TOPIC_ID_INVALID|TOPIC_DELETED/i.test(String(e))) {
        thread = await recreateTopic(api, g.chatId, topic);
        await send(thread);
      } else throw e;
    }
    return true;
  } catch (e) {
    console.error("adminGroup.report failed:", errText(e));
    return false;
  }
}

/** ارسال عکس (رسید) به تاپیک مالی */
export async function reportPhoto(api: Api, topic: Topic, fileId: string, caption: string): Promise<boolean> {
  try {
    const g = await getGroup();
    if (!g.chatId) return false;
    const thread = g.topics[topic] ?? (await recreateTopic(api, g.chatId, topic));
    await api.sendPhoto(g.chatId, fileId, { caption: caption.slice(0, 1000), parse_mode: "HTML", message_thread_id: thread });
    return true;
  } catch (e) {
    console.error("adminGroup.reportPhoto failed:", errText(e));
    return false;
  }
}

async function recreateTopic(api: Api, chatId: number, topic: Topic): Promise<number> {
  const created = await api.createForumTopic(chatId, `${TOPICS[topic].icon} ${TOPICS[topic].title}`);
  await setKV(TOPICS[topic].key, String(created.message_thread_id));
  return created.message_thread_id;
}

/** خطاها: اگر گروه تنظیم باشد در تاپیک «خطا»، وگرنه مثل قبل پیام خصوصی به ادمین‌ها */
export async function reportError(api: Api, html: string, extra: Record<string, unknown> = {}) {
  if (await report(api, "errors", html, extra)) return;
  for (const id of config.admins) await api.sendMessage(id, html.slice(0, 4000), { parse_mode: "HTML", ...extra }).catch(() => {});
}

// ───────────────────────── کد شناسه تراکنش‌ها ─────────────────────────
export const codes = {
  deposit: (id: number) => `PAY-${id}`,
  buy: (sid: number) => `BUY-${sid}`,
  adjust: (id: number) => `ADJ-${id}`,
  refund: (sid: number) => `RFD-${sid}`,
  renew: (sid: number) => `RNW-${sid}`,
  report: (id: number) => `RPT-${id}`,
};

export const stamp = () =>
  new Date().toLocaleString("fa-IR", { timeZone: "Asia/Tehran", dateStyle: "short", timeStyle: "short" });

/** اطلاعات پرداخت‌کننده/کاربر */
export async function payerInfo(userId: number): Promise<string> {
  const u = await queryOne<{ username: string | null; balance: number }>("SELECT username, balance FROM users WHERE id=$1", [userId]);
  return (
    `👤 کاربر: <code>${userId}</code>${u?.username ? " @" + esc(u.username) : ""}\n` +
    `💳 موجودی فعلی: <b>${fmtN(u?.balance ?? 0)}</b> تومان`
  );
}

import type { Context } from "grammy";

export type BotContext = Context & { isNewUser: boolean };

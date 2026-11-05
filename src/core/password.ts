import { randomInt } from "node:crypto";

const ALPHA = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** پسورد ۱۶ کاراکتری با حروف کوچک/بزرگ و عدد (بدون کاراکتر خاص تا روی همه OSها مشکلی نداشته باشد) */
export function genPassword(len = 16): string {
  for (;;) {
    let p = "";
    for (let i = 0; i < len; i++) p += ALPHA[randomInt(ALPHA.length)];
    if (/[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p)) return p;
  }
}

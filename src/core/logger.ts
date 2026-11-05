/** لاگ برچسب‌دار: [scope] پیام — برای جدا کردن لاگ هر دیتاسنتر/ماژول در journalctl */
export function logger(scope: string) {
  const p = `[${scope}]`;
  return {
    info: (...a: unknown[]) => console.log(p, ...a),
    warn: (...a: unknown[]) => console.warn(p, ...a),
    error: (...a: unknown[]) => console.error(p, ...a),
  };
}

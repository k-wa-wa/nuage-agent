export type LogListener = (
  level: 'info' | 'success' | 'warn' | 'error' | 'debug',
  msg: string,
  err?: unknown,
) => void;
let logListener: LogListener | null = null;

export const logger = {
  setLogListener(listener: LogListener | null) {
    logListener = listener;
  },
  info(message: string, context?: string) {
    const ctx = context ? `[${context}] ` : '';
    const formatted = `${ctx}${message}`;
    if (logListener) {
      logListener('info', formatted);
    } else {
      console.log(`\x1b[36m%s\x1b[0m`, formatted);
    }
  },
  success(message: string, context?: string) {
    const ctx = context ? `[${context}] ` : '';
    const formatted = `${ctx}${message}`;
    if (logListener) {
      logListener('success', formatted);
    } else {
      console.log(`\x1b[32m%s\x1b[0m`, `✔ ${formatted}`);
    }
  },
  warn(message: string, context?: string, error?: unknown) {
    const ctx = context ? `[${context}] ` : '';
    const formatted = `${ctx}${message}`;
    if (logListener) {
      logListener('warn', formatted, error);
    } else {
      console.warn(`\x1b[33m%s\x1b[0m`, `⚠ ${formatted}`);
      if (error) {
        console.warn(error);
      }
    }
  },
  error(message: string, context?: string, error?: unknown) {
    const ctx = context ? `[${context}] ` : '';
    const formatted = `${ctx}${message}`;
    if (logListener) {
      logListener('error', formatted, error);
    } else {
      console.error(`\x1b[31m%s\x1b[0m`, `✘ ${formatted}`);
      if (error) {
        console.error(error);
      }
    }
  },
  debug(message: string, context?: string) {
    if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
      const ctx = context ? `[${context}] ` : '';
      const formatted = `${ctx}${message}`;
      if (logListener) {
        logListener('debug', formatted);
      } else {
        console.log(`\x1b[90m%s\x1b[0m`, `[DEBUG] ${formatted}`);
      }
    }
  },
};

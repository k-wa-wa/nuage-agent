/**
 * @what 進捗やエラー等のログを色付きでコンソールに出力するカスタムロギングユーティリティです。
 * @why ランナーやエージェントの各モジュールが実行状況をプレフィックス付きで識別しやすく、かつデバッグログの有効化（DEBUG環境変数）等を一括制御するため。
 */
export const logger = {
  info(message: string, context?: string) {
    const ctx = context ? `[${context}] ` : '';
    console.log(`\x1b[36m%s\x1b[0m`, `${ctx}${message}`);
  },
  success(message: string, context?: string) {
    const ctx = context ? `[${context}] ` : '';
    console.log(`\x1b[32m%s\x1b[0m`, `✔ ${ctx}${message}`);
  },
  warn(message: string, context?: string) {
    const ctx = context ? `[${context}] ` : '';
    console.warn(`\x1b[33m%s\x1b[0m`, `⚠ ${ctx}${message}`);
  },
  error(message: string, context?: string, error?: unknown) {
    const ctx = context ? `[${context}] ` : '';
    console.error(`\x1b[31m%s\x1b[0m`, `✘ ${ctx}${message}`);
    if (error) {
      console.error(error);
    }
  },
  debug(message: string, context?: string) {
    if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
      const ctx = context ? `[${context}] ` : '';
      console.log(`\x1b[90m%s\x1b[0m`, `[DEBUG] ${ctx}${message}`);
    }
  },
};

import { logger } from '../../core/index.js';

interface TaskFailureState {
  consecutiveFailures: number;
  coolDownUntil?: number;
}

// メモリ上でタスクの状態を保持する
const taskStates = new Map<string, TaskFailureState>();

const COOL_DOWN_DURATION_MS = 30 * 60 * 1000; // 30 minutes

/**
 * @what エラーメッセージからAPI利用上限（セッション制限・レート制限）によるエラーかどうかを判定します。
 * @why Claude CLI の "You've hit your session limit" や Gemini API の 429 / Quota Exceeded などを識別するため。
 */
export function isSessionLimitError(error: unknown): boolean {
  const msg = String(error instanceof Error ? error.message : error).toLowerCase();
  return (
    msg.includes('session limit') ||
    msg.includes('rate limit') ||
    msg.includes('quota exceeded') ||
    msg.includes('too many requests') ||
    msg.includes('resourceexhausted') ||
    msg.includes('429')
  );
}

/**
 * @what 指定されたタスクがクールダウン期間中であるかを判定します。
 * @why クールダウン中のタスクをクローラーが二重にキュー登録しないようにするため。
 */
export function isTaskInCoolDown(key: string): boolean {
  const state = taskStates.get(key);
  if (state?.coolDownUntil && Date.now() < state.coolDownUntil) {
    return true;
  }
  return false;
}

/**
 * @what タスクの実行が成功した際に、失敗カウントをクリアします。
 * @why 正常終了したタスクの古い連続失敗履歴をリセットするため。
 */
export function clearTaskFailure(key: string): void {
  const state = taskStates.get(key);
  if (state) {
    state.consecutiveFailures = 0;
    state.coolDownUntil = undefined;
    taskStates.set(key, state);
  }
}

/**
 * @what タスクの実行失敗を記録し、triage（手動介入待ち）へ遷移すべきかを判定します。
 * @why 利用上限エラーの場合は30分間のクールダウンを設定し、その他の通常エラーが3回連続した場合は triage 移行と判定するため。
 * @returns triageへ移行すべきであれば true、一時クールダウンまたは通常エラー（閾値未満）であれば false。
 */
export function recordTaskFailure(key: string, error: unknown): boolean {
  const state = taskStates.get(key) ?? { consecutiveFailures: 0 };

  if (isSessionLimitError(error)) {
    logger.warn(
      `[State] Session/Rate limit detected for ${key}. Cooling down for 30 minutes.`,
      'pool',
    );
    state.coolDownUntil = Date.now() + COOL_DOWN_DURATION_MS;
    taskStates.set(key, state);
    return false;
  }

  state.consecutiveFailures += 1;
  logger.warn(`[State] Task ${key} failed (${state.consecutiveFailures}/3).`, 'pool');

  if (state.consecutiveFailures >= 3) {
    logger.error(`[State] Task ${key} failed consecutively 3 times. Requesting triage...`, 'pool');
    // triageに移行するため、失敗カウントはリセットする
    state.consecutiveFailures = 0;
    state.coolDownUntil = undefined;
    taskStates.set(key, state);
    return true;
  }

  taskStates.set(key, state);
  return false;
}

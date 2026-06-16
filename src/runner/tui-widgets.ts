import { conflictPool, nonConflictPool, getShuttingDown } from './pool.js';
import { type TaskState, type TuiState } from './tui.js';

/**
 * @what ヘッダーパネルに表示するテキストを生成します。
 * @why opentui TextRenderable.content に渡すため、ANSI付きの文字列を生成する。
 */
export function buildHeaderText(state: TuiState): string {
  const now = new Date().toLocaleTimeString();
  const uptime = Math.floor((Date.now() - state.startTime.getTime()) / 1000);
  const status = getShuttingDown() ? '[SHUTTING DOWN]' : '[RUNNING]';
  const repos = state.repos.length === 0 ? 'None' : state.repos.join(', ');
  const lastCrawl = state.lastCrawlTime ? state.lastCrawlTime.toLocaleTimeString() : 'Never';

  return (
    ` Status: ${status}  Uptime: ${uptime}s  Time: ${now}  LastCrawl: ${lastCrawl}\n` +
    ` Repos: ${repos}`
  );
}

function drawBar(val: number, max: number): string {
  const filled = '█'.repeat(val);
  const empty = '░'.repeat(Math.max(0, max - val));
  return `[${filled}${empty}] ${val}/${max}`;
}

/**
 * @what プールパネルに表示するテキストを生成します。
 * @why ConflictPool / NonConflictPool の稼働状況をバーで可視化するため。
 */
export function buildPoolsText(): string {
  const cA = conflictPool.active;
  const cS = conflictPool.size;
  const nA = nonConflictPool.active;
  const nS = nonConflictPool.size;

  return (
    ` ConflictPool (Serial):       ${drawBar(cA, 1)}  (Queued: ${cS})\n` +
    ` NonConflictPool (Parallel):  ${drawBar(nA, 3)}  (Queued: ${nS})`
  );
}

function formatTaskStatus(t: TaskState): string {
  if (t.status === 'queued') return 'QUEUED';
  if (t.status === 'running') {
    const elapsed = Math.floor((Date.now() - (t.startTime?.getTime() ?? 0)) / 1000);
    return `RUNNING (${elapsed}s)`;
  }
  if (t.status === 'completed') return 'SUCCESS';
  const errPart = t.error ? ` (${t.error})` : '';
  return `FAILED${errPart}`;
}

/**
 * @what タスクパネルに表示するテキストを生成します。
 * @why 最新7件のタスクをステータス付きで一覧表示するため。
 */
export function buildTasksText(state: TuiState): string {
  const tasks = Array.from(state.tasks.values()).reverse().slice(0, 7);
  if (tasks.length === 0) {
    return ' No tasks registered yet.';
  }
  return tasks.map((t) => `  • [${t.repo}] ${t.name}  ➔  ${formatTaskStatus(t)}`).join('\n');
}

/**
 * @what ログエントリをプレーンテキスト文字列に変換します。
 * @why opentui TextRenderable は ANSI エスケープコードをレンダリングせず文字列として表示するため、ANSI なしで記号のみで level を示す。
 */
export function formatLogLine(level: string, msg: string, err?: unknown): string {
  const errStr =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : err !== null && err !== undefined
          ? JSON.stringify(err)
          : '';

  const errPart = errStr ? ` - ${errStr}` : '';

  if (level === 'success') return `✔ ${msg}${errPart}`;
  if (level === 'warn') return `⚠ ${msg}${errPart}`;
  if (level === 'error') return `✘ ${msg}${errPart}`;
  if (level === 'debug') return `[dbg] ${msg}${errPart}`;
  return `${msg}${errPart}`;
}

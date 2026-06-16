import {
  createCliRenderer,
  BoxRenderable,
  TextRenderable,
  ScrollBoxRenderable,
  type CliRenderer,
} from '@opentui/core';
import { logger } from '../../core/logger.js';
import { buildHeaderText, buildPoolsText, buildTasksText, formatLogLine } from './widgets.js';

// ─── Public State ────────────────────────────────────────────────────────────

export interface TaskState {
  key: string;
  repo: string;
  name: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  startTime?: Date;
  endTime?: Date;
  error?: string;
}

export interface TuiState {
  enabled: boolean;
  repos: string[];
  lastCrawlTime: Date | null;
  tasks: Map<string, TaskState>;
  logs: string[];
  startTime: Date;
}

export const tuiState: TuiState = {
  enabled: false,
  repos: [],
  lastCrawlTime: null,
  tasks: new Map<string, TaskState>(),
  logs: [],
  startTime: new Date(),
};

// ─── Internal Widget References ───────────────────────────────────────────────

let renderer: CliRenderer | null = null;
let headerText: TextRenderable | null = null;
let poolsText: TextRenderable | null = null;
let tasksText: TextRenderable | null = null;
let logsText: TextRenderable | null = null;
let drawInterval: NodeJS.Timeout | null = null;

// ─── Layout Building ──────────────────────────────────────────────────────────

const ACCENT = '#00d4ff';
const BG_PANEL = '#0d1117';

function buildHeaderPanel(ctx: CliRenderer): TextRenderable {
  const box = new BoxRenderable(ctx, {
    width: '100%',
    height: 4,
    border: true,
    borderColor: ACCENT,
    backgroundColor: BG_PANEL,
    title: ' ☁  Nuage Pipeline Runner ',
    titleColor: ACCENT,
    padding: 0,
  });
  ctx.root.add(box);

  const text = new TextRenderable(ctx, {
    width: '100%',
    height: '100%',
    fg: '#e6edf3',
    bg: BG_PANEL,
    wrapMode: 'word',
    padding: 1,
  });
  box.add(text);
  return text;
}

function buildPoolsPanel(ctx: CliRenderer): TextRenderable {
  const box = new BoxRenderable(ctx, {
    width: '100%',
    height: 5,
    border: true,
    borderColor: ACCENT,
    backgroundColor: BG_PANEL,
    title: ' ⚙  Execution Pools ',
    titleColor: ACCENT,
    padding: 0,
  });
  ctx.root.add(box);

  const text = new TextRenderable(ctx, {
    width: '100%',
    height: '100%',
    fg: '#e6edf3',
    bg: BG_PANEL,
    padding: 1,
  });
  box.add(text);
  return text;
}

function buildTasksPanel(ctx: CliRenderer): TextRenderable {
  const box = new BoxRenderable(ctx, {
    width: '100%',
    height: 10,
    border: true,
    borderColor: ACCENT,
    backgroundColor: BG_PANEL,
    title: ' ▶  Active & Recent Tasks (max 7) ',
    titleColor: ACCENT,
    padding: 0,
  });
  ctx.root.add(box);

  const text = new TextRenderable(ctx, {
    width: '100%',
    height: '100%',
    fg: '#e6edf3',
    bg: BG_PANEL,
    padding: 1,
    wrapMode: 'word',
  });
  box.add(text);
  return text;
}

function buildLogsPanel(ctx: CliRenderer): {
  scroll: ScrollBoxRenderable;
  text: TextRenderable;
} {
  const scroll = new ScrollBoxRenderable(ctx, {
    width: '100%',
    flexGrow: 1,
    border: true,
    borderColor: ACCENT,
    backgroundColor: BG_PANEL,
    title: ' 📋  Logs ',
    titleColor: ACCENT,
    stickyScroll: true,
    stickyStart: 'bottom',
    scrollY: true,
    scrollX: false,
  });
  ctx.root.add(scroll);

  const text = new TextRenderable(ctx, {
    width: '100%',
    fg: '#8b949e',
    bg: BG_PANEL,
    wrapMode: 'word',
  });
  scroll.add(text);
  return { scroll, text };
}

// ─── Log Hook ─────────────────────────────────────────────────────────────────

const TUI_LOG_MAX_LINE = 200;
const TUI_LOG_MAX_LINES = 200;

function setupLoggerHook(): void {
  const listener = (level: string, msg: string, err?: unknown) => {
    const truncMsg = msg.length > TUI_LOG_MAX_LINE ? `${msg.slice(0, TUI_LOG_MAX_LINE)}…` : msg;
    const line = formatLogLine(level, truncMsg, err);
    tuiState.logs.push(line);
    if (tuiState.logs.length > TUI_LOG_MAX_LINES) {
      tuiState.logs.shift();
    }
  };
  logger.setLogListener(listener);
}

// ─── Draw Loop ────────────────────────────────────────────────────────────────

function draw(): void {
  if (!renderer) {
    return;
  }
  if (headerText) {
    headerText.content = buildHeaderText(tuiState);
  }
  if (poolsText) {
    poolsText.content = buildPoolsText();
  }
  if (tasksText) {
    tasksText.content = buildTasksText(tuiState);
  }
  if (logsText) {
    logsText.content = tuiState.logs.join('\n');
  }
  renderer.requestRender();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * @what TUIダッシュボードを初期化・起動します（opentui使用）。
 * @why opentui の createCliRenderer は非同期のため、async 関数として提供する。
 */
export async function initTui(): Promise<void> {
  tuiState.enabled = true;

  renderer = await createCliRenderer({
    exitOnCtrlC: true,
    clearOnShutdown: true,
    targetFps: 10,
    backgroundColor: '#010409',
  });

  renderer.root.flexDirection = 'column';
  renderer.root.padding = 0;

  headerText = buildHeaderPanel(renderer);
  poolsText = buildPoolsPanel(renderer);
  tasksText = buildTasksPanel(renderer);
  const logsPanel = buildLogsPanel(renderer);
  logsText = logsPanel.text;

  setupLoggerHook();
  renderer.start();

  drawInterval = setInterval(draw, 500);
  draw();
}

/**
 * @what TUI表示を終了し、標準ターミナル状態に復元します。
 * @why 終了後にカーソルや画面を破棄して、通常のコンソール表示に戻すため。
 */
export function stopTui(): void {
  if (drawInterval) {
    clearInterval(drawInterval);
    drawInterval = null;
  }
  tuiState.enabled = false;
  if (renderer) {
    renderer.destroy();
    renderer = null;
    headerText = null;
    poolsText = null;
    tasksText = null;
    logsText = null;
  }
}

/**
 * @what タスクがキュー（待機）状態に入ったことをTUI状態に登録します。
 * @why タスク一覧に「QUEUED」として表示するため。
 */
export function taskQueued(key: string, repo: string, name: string): void {
  tuiState.tasks.set(key, { key, repo, name, status: 'queued' });
}

/**
 * @what タスクが実行（アクティブ）状態に入ったことをTUI状態に登録します。
 * @why タスク一覧に「RUNNING」として表示するため。
 */
export function taskStarted(key: string): void {
  const task = tuiState.tasks.get(key);
  if (task) {
    task.status = 'running';
    task.startTime = new Date();
  }
}

/**
 * @what タスクが完了または失敗したことをTUI状態に登録します。
 * @why タスク一覧に「SUCCESS」または「FAILED」として結果と所要時間を表示するため。
 */
export function taskFinished(key: string, success: boolean, error?: string): void {
  const task = tuiState.tasks.get(key);
  if (task) {
    task.status = success ? 'completed' : 'failed';
    task.endTime = new Date();
    task.error = error;
  }
}

/**
 * @what 監視対象リポジトリ群の名前を設定します。
 * @why ダッシュボードのヘッダーに監視リストを表示するため。
 */
export function setRepos(repos: string[]): void {
  tuiState.repos = repos;
}

/**
 * @what 最終クロール実行時刻を設定します。
 * @why 前回のポーリング完了時刻をヘッダー付近に表示するため。
 */
export function setLastCrawlTime(date: Date): void {
  tuiState.lastCrawlTime = date;
}

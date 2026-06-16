import type { AppConfig } from '../../core/index.js';
import type { Agent, AgentContext } from '../../agents/index.js';
import { logger } from '../../core/index.js';
import { updateLabels } from '../../github/index.js';
import { setupWorktree, cleanupWorktree } from '../workspace/index.js';
import { removeTaskActive } from './pool.js';
import { executeAgentCLI } from './cli.js';
import * as tui from '../tui/index.js';

export interface TaskLifecycleOptions {
  repo: string;
  taskKey: string;
  taskNumber: string;
  agent: Agent;
  config: AppConfig;
  branchName: string;
  isPR: boolean;
  prNumber?: number;
  buildContext: () => AgentContext;
  onStartLog: () => string;
  onStartLabelsUpdate?: {
    add: string[];
    remove: string[];
  };
  onFinishLabelsUpdate?: {
    add: string[];
    remove: string[];
  };
}

/**
 * @what タスク番号とPR判定情報から、操作対象となる GitHub Issue/PR 番号を解決します。
 * @why 行数を削減し、関数の役割を細分化するため。
 */
function getTargetNumber(taskNumber: string, isPR: boolean, prNumber?: number): number {
  return isPR ? (prNumber ?? parseInt(taskNumber, 10)) : parseInt(taskNumber, 10);
}

/**
 * @what 設定されたラベル追加・削除情報に基づいて、GitHubラベルを安全に更新します。
 * @why 条件分岐ロジックとエラーハンドリングを別関数に切り出して、メイン関数の複雑度を下げるため。
 */
async function tryUpdateLabels(
  repo: string,
  targetNumber: number,
  labels?: { add: string[]; remove: string[] },
): Promise<void> {
  if (labels && !isNaN(targetNumber)) {
    await updateLabels(repo, targetNumber, labels.add, labels.remove);
  }
}

/**
 * @what タスク実行の終了ログを出力します。
 * @why ログ文字列の組み立てによる行数増加を防ぐため。
 */
function logFinished(agentId: string, taskNumber: string, repo: string, success: boolean): void {
  logger.info(
    `\n┌────────────────────────────────────────────────────────────────────────────────` +
      `\n│ <<< Finished Agent: [${agentId}] on Task #${taskNumber} in ${repo}` +
      `\n│     Status: ${success ? 'SUCCESS' : 'FAILED'}` +
      `\n└────────────────────────────────────────────────────────────────────────────────\n`,
    'crawler',
  );
}

/**
 * @what エージェントタスクの共通ライフサイクル（Worktree準備、プロンプト構築、CLI実行、クリーンアップ、TUI通知、ラベル更新など）を実行します。
 * @why 各タスク実行箇所（Issue, PR, QA）におけるボイラープレートコードや重複した try-catch-finally ブロックを共通化し、コードの見通しと保守性を高めるため。
 */
export async function runAgentTask(opts: TaskLifecycleOptions): Promise<void> {
  const {
    repo,
    taskKey,
    taskNumber,
    agent,
    config,
    branchName,
    isPR,
    prNumber,
    buildContext,
    onStartLog,
    onStartLabelsUpdate,
    onFinishLabelsUpdate,
  } = opts;
  const targetNumber = getTargetNumber(taskNumber, isPR, prNumber);
  let workspacePath = '';
  let success = true;

  try {
    logger.info(onStartLog(), 'crawler');
    await tryUpdateLabels(repo, targetNumber, onStartLabelsUpdate);
    tui.taskStarted(taskKey);

    workspacePath = setupWorktree(config, { repo, taskNumber, branchName, isPR, prNumber });
    const prompt = agent.buildPrompt(buildContext());

    await executeAgentCLI(config, { agent, prompt, workspacePath, taskNumber });
  } catch (error) {
    success = false;
    logger.error(
      `Error executing Agent ${agent.id} for task ${taskNumber} in ${repo}`,
      'crawler',
      error,
    );
  } finally {
    if (workspacePath) {
      cleanupWorktree(repo, taskNumber, config);
    }
    await tryUpdateLabels(repo, targetNumber, onFinishLabelsUpdate);
    tui.taskFinished(taskKey, success);
    removeTaskActive(taskKey);
    logFinished(agent.id, taskNumber, repo, success);
  }
}

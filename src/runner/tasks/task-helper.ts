import type { AppConfig } from '../../core/index.js';
import type { Agent, AgentContext } from '../../agents/index.js';
import { logger } from '../../core/index.js';
import { updateLabels, addIssueComment, addPullRequestComment } from '../../github/index.js';
import { setupWorktree, cleanupWorktree } from '../workspace/index.js';
import { removeTaskActive } from './pool.js';
import { executeAgentCLI } from './cli.js';
import * as tui from '../tui/index.js';
import { recordTaskFailure, clearTaskFailure } from './task-state.js';

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
  const targetNumber = getTargetNumber(opts.taskNumber, opts.isPR, opts.prNumber);
  let workspacePath = '';
  let success = true;
  let forceTriage = false;

  try {
    workspacePath = await setupAndExecuteAgent(opts, targetNumber);
    clearTaskFailure(opts.taskKey);
  } catch (error) {
    success = false;
    logger.error(
      `Error executing Agent ${opts.agent.id} for task ${opts.taskNumber} in ${opts.repo}`,
      'crawler',
      error,
    );
    forceTriage = await handleTaskFailure({
      taskKey: opts.taskKey,
      error,
      agent: opts.agent,
      repo: opts.repo,
      isPR: opts.isPR,
      prNumber: opts.prNumber,
      targetNumber,
    });
  } finally {
    if (workspacePath) {
      cleanupWorktree(opts.repo, opts.taskNumber, opts.config);
    }

    await finalizeTaskLabels({
      repo: opts.repo,
      targetNumber,
      onFinishLabelsUpdate: opts.onFinishLabelsUpdate,
      forceTriage,
      agentLabel: opts.agent.label,
    });

    tui.taskFinished(opts.taskKey, success);
    removeTaskActive(opts.taskKey);
    logFinished(opts.agent.id, opts.taskNumber, opts.repo, success);
  }
}

/**
 * @what ワークスペースの準備、プロンプトの構築、およびエージェントCLIの実行を一括で行います。
 * @why runAgentTask 関数の物理行数を削減し、ESLint の関数行数制限を満たすため。
 */
async function setupAndExecuteAgent(
  opts: TaskLifecycleOptions,
  targetNumber: number,
): Promise<string> {
  logger.info(opts.onStartLog(), 'crawler');
  await tryUpdateLabels(opts.repo, targetNumber, opts.onStartLabelsUpdate);
  tui.taskStarted(opts.taskKey);

  const workspacePath = setupWorktree(opts.config, {
    repo: opts.repo,
    taskNumber: opts.taskNumber,
    branchName: opts.branchName,
    isPR: opts.isPR,
    prNumber: opts.prNumber,
  });
  const prompt = opts.agent.buildPrompt(opts.buildContext());

  await executeAgentCLI(opts.config, {
    agent: opts.agent,
    prompt,
    workspacePath,
    taskNumber: opts.taskNumber,
  });
  return workspacePath;
}

/**
 * @what タスク失敗時のロギング、カウント記録、および triage 移行判定と通知コメント投稿を行います。
 * @why 3回連続失敗時の手動トリアージ移行プロセスを分離し、呼び出し元の複雑度を下げるため。
 */
async function handleTaskFailure(options: {
  taskKey: string;
  error: unknown;
  agent: Agent;
  repo: string;
  isPR: boolean;
  prNumber?: number;
  targetNumber: number;
}): Promise<boolean> {
  const { taskKey, error, agent, repo, isPR, prNumber, targetNumber } = options;
  const shouldTriage = recordTaskFailure(taskKey, error);
  if (shouldTriage) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    const commentBody = `❌ **Supervisor Alert**: エージェント \`${agent.id}\` が3回連続で実行失敗したため、状態を \`agent:triage\` (人間による調査) に移行しました。\n\n**最終エラー内容:**\n\`\`\`\n${errorMessage}\n\`\`\``;
    try {
      if (isPR && prNumber) {
        await addPullRequestComment(repo, prNumber, commentBody);
      } else {
        await addIssueComment(repo, targetNumber, commentBody);
      }
    } catch (commentError) {
      logger.error(`Failed to post triage comment for task ${taskKey}`, 'crawler', commentError);
    }
    return true;
  }
  return false;
}

/**
 * @what タスク終了時のGitHubラベルの更新を処理します。
 * @why ラベル更新の組み立てロジックを別関数に委譲して行数を削減するため。
 */
async function finalizeTaskLabels(options: {
  repo: string;
  targetNumber: number;
  onFinishLabelsUpdate?: { add: string[]; remove: string[] };
  forceTriage: boolean;
  agentLabel: string;
}): Promise<void> {
  const { repo, targetNumber, onFinishLabelsUpdate, forceTriage, agentLabel } = options;
  const labelsToUpdate = {
    add: [...(onFinishLabelsUpdate?.add ?? [])],
    remove: [...(onFinishLabelsUpdate?.remove ?? [])],
  };

  if (forceTriage) {
    labelsToUpdate.add.push('agent:triage');
    labelsToUpdate.remove.push(agentLabel);
  }

  await tryUpdateLabels(repo, targetNumber, labelsToUpdate);
}

import type { AppConfig, GitHubPullRequest } from '../../core/index.js';
import type { Agent } from '../../agents/index.js';
import { logger } from '../../core/index.js';
import { updatePullRequestLabels, getPullRequest } from '../../github/index.js';
import { setupWorktree, cleanupWorktree } from '../workspace/index.js';
import { removeTaskActive } from './pool.js';
import { executeAgentCLI } from './cli.js';
import * as tui from '../tui/index.js';

/**
 * @what PRに対するエージェント処理を実行するためのオプション。
 * @why 関数のパラメータ数を上限（4個）以内に抑えて可読性を高めるため。
 */
export interface PRTaskOptions {
  repo: string;
  agent: Agent;
  pr: GitHubPullRequest;
  config: AppConfig;
  repoMapMd: string;
}

/**
 * @what 最新のPRラベルを取得し、実行可能か（他で実行中になっていないか等）検証します。
 * @why 分散実行時の二重実行防止（排他制御）を厳密にい行うため。
 */
async function performPRLockCheck(
  repo: string,
  pr: GitHubPullRequest,
  agent: Agent,
): Promise<boolean> {
  const freshPR = await getPullRequest(repo, pr.number);
  if (!freshPR) {
    logger.warn(`Skipping PR #${pr.number}: could not fetch fresh.`, 'crawler');
    return true;
  }
  if (freshPR.labels.includes('agent:running')) {
    logger.info(`Skipping PR #${pr.number}: locked by another process.`, 'crawler');
    return true;
  }
  if (!freshPR.labels.includes(agent.label)) {
    logger.info(`Skipping PR #${pr.number}: target label removed.`, 'crawler');
    return true;
  }
  return false;
}

/**
 * @what PRに対応するworktreeを作成し、エージェントCLIを実行して後片付けを行います。
 * @why 隔離環境下でPRブランチを検証し、実行完了後に状態を更新するため。
 */
async function executePRCLI(taskNumber: string, options: PRTaskOptions): Promise<boolean> {
  const { repo, agent, pr, config, repoMapMd } = options;
  let workspacePath = '';
  let success = true;

  try {
    workspacePath = setupWorktree(config, {
      repo,
      taskNumber,
      branchName: pr.branch,
      isPR: true,
      prNumber: pr.number,
    });
    const context = { repoName: repo, repoMapMd, pr, autoMerge: config.qaAutoMerge };
    const prompt = agent.buildPrompt(context);

    await executeAgentCLI(config, { agent, prompt, workspacePath, taskNumber });
  } catch (error) {
    success = false;
    logger.error(`Error executing Agent ${agent.id} on PR #${pr.number}`, 'crawler', error);
  } finally {
    await updatePullRequestLabels(repo, pr.number, [], ['agent:running']);
    if (workspacePath) {
      cleanupWorktree(repo, taskNumber, config);
    }
    logger.info(
      `\n┌────────────────────────────────────────────────────────────────────────────────` +
        `\n│ <<< Finished Agent: [${agent.id}] on PR #${pr.number} in ${repo}` +
        `\n│     Status: ${success ? 'SUCCESS' : 'FAILED'}` +
        `\n└────────────────────────────────────────────────────────────────────────────────\n`,
      'crawler',
    );
  }
  return success;
}

/**
 * @what PRに対するエージェントのライフサイクル全体の実行を制御します。
 * @why ロック確認・獲得、隔離ワークツリー構築、CLI起動、後処理・解除の流れを統合実行するため。
 */
export async function runPRAgentTask(options: PRTaskOptions): Promise<void> {
  const { repo, agent, pr } = options;
  const key = `${repo}#${pr.number}-${agent.id}`;

  try {
    const isLocked = await performPRLockCheck(repo, pr, agent);
    if (isLocked) {
      return;
    }

    logger.info(
      `\n┌────────────────────────────────────────────────────────────────────────────────` +
        `\n│ >>> Starting Agent: [${agent.id}] on PR #${pr.number} in ${repo}` +
        `\n│     Title: "${pr.title}"` +
        `\n└────────────────────────────────────────────────────────────────────────────────`,
      'crawler',
    );

    await updatePullRequestLabels(repo, pr.number, ['agent:running'], []);

    const taskNumber = `${pr.number}-${agent.id}`;
    tui.taskStarted(key);
    const success = await executePRCLI(taskNumber, options);
    tui.taskFinished(key, success);
  } finally {
    removeTaskActive(key);
  }
}

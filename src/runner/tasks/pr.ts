import type { AppConfig, GitHubPullRequest } from '../../core/index.js';
import type { Agent } from '../../agents/index.js';
import { logger } from '../../core/index.js';
import { getPullRequest } from '../../github/index.js';
import { runAgentTask } from './task-helper.js';

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
 * @why 分散実行時の二重実行防止（排他制御）を厳密に行うため。
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
 * @what PRに対するエージェントのライフサイクル全体の実行を制御します。
 * @why ロック確認を経て、共通の runAgentTask ヘルパーを呼び出して隔離ワークツリー構築・CLI起動・後処理を統合実行するため。
 */
export async function runPRAgentTask(options: PRTaskOptions): Promise<void> {
  const { repo, agent, pr, config, repoMapMd } = options;
  const key = `${repo}#${pr.number}-${agent.id}`;

  const isLocked = await performPRLockCheck(repo, pr, agent);
  if (isLocked) {
    return;
  }

  const taskNumber = `${pr.number}-${agent.id}`;

  await runAgentTask({
    repo,
    taskKey: key,
    taskNumber,
    agent,
    config,
    branchName: pr.branch,
    isPR: true,
    prNumber: pr.number,
    buildContext: () => ({ repoName: repo, repoMapMd, pr, autoMerge: config.qaAutoMerge }),
    onStartLog: () =>
      `\n┌────────────────────────────────────────────────────────────────────────────────` +
      `\n│ >>> Starting Agent: [${agent.id}] on PR #${pr.number} in ${repo}` +
      `\n│     Title: "${pr.title}"` +
      `\n└────────────────────────────────────────────────────────────────────────────────`,
    onStartLabelsUpdate: { add: ['agent:running'], remove: [] },
    onFinishLabelsUpdate: { add: [], remove: ['agent:running'] },
  });
}

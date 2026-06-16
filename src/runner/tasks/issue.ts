import type { AppConfig, GitHubIssue } from '../../core/index.js';
import type { Agent } from '../../agents/index.js';
import { logger } from '../../core/index.js';
import { getIssue } from '../../github/index.js';
import { runAgentTask } from './task-helper.js';

/**
 * @what Issueに対するエージェント処理を実行するためのオプション。
 * @why 関数のパラメータ数を上限（4個）以内に抑えて可読性を高めるため。
 */
export interface IssueTaskOptions {
  repo: string;
  agent: Agent;
  issue: GitHubIssue;
  config: AppConfig;
  repoMapMd: string;
}

/**
 * @what 最新のIssueラベルを取得し、実行可能か（ロック中やユーザー返答待ちでないか）検証します。
 * @why 分散実行時の二重実行防止（排他制御）を厳密に行うため。
 */
async function performIssueLockCheck(
  repo: string,
  issue: GitHubIssue,
  agent: Agent,
): Promise<boolean> {
  const freshIssue = await getIssue(repo, issue.number);
  if (!freshIssue) {
    logger.warn(`Skipping Issue #${issue.number}: could not fetch fresh.`, 'crawler');
    return true;
  }
  if (freshIssue.labels.includes('agent:running')) {
    logger.info(`Skipping Issue #${issue.number}: locked by another process.`, 'crawler');
    return true;
  }
  if (freshIssue.labels.includes('agent:wait')) {
    logger.info(`Skipping Issue #${issue.number}: agent:wait detected.`, 'crawler');
    return true;
  }
  if (!freshIssue.labels.includes(agent.label)) {
    logger.info(`Skipping Issue #${issue.number}: target label removed.`, 'crawler');
    return true;
  }
  return false;
}

/**
 * @what Issueに対するエージェントのライフサイクル全体の実行を制御します。
 * @why ロック確認を経て、共通の runAgentTask ヘルパーを呼び出して隔離ワークツリー構築・CLI起動・後処理を統合実行するため。
 */
export async function runIssueAgentTask(options: IssueTaskOptions): Promise<void> {
  const { repo, agent, issue, config, repoMapMd } = options;
  const key = `${repo}#${issue.number}-${agent.id}`;

  const isLocked = await performIssueLockCheck(repo, issue, agent);
  if (isLocked) {
    return;
  }

  const taskNumber = `${issue.number}-${agent.id}`;
  const branchName = `agent/issue-${issue.number}`;

  await runAgentTask({
    repo,
    taskKey: key,
    taskNumber,
    agent,
    config,
    branchName,
    isPR: false,
    buildContext: () => ({ repoName: repo, repoMapMd, issue }),
    onStartLog: () =>
      `\n┌────────────────────────────────────────────────────────────────────────────────` +
      `\n│ >>> Starting Agent: [${agent.id}] on Issue #${issue.number} in ${repo}` +
      `\n│     Title: "${issue.title}"` +
      `\n└────────────────────────────────────────────────────────────────────────────────`,
    onStartLabelsUpdate: { add: ['agent:running'], remove: [] },
    onFinishLabelsUpdate: { add: [], remove: ['agent:running'] },
  });
}

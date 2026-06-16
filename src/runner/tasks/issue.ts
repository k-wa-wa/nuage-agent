import type { AppConfig, GitHubIssue } from '../../core/index.js';
import type { Agent } from '../../agents/index.js';
import { logger } from '../../core/index.js';
import { updateIssueLabels, getIssue } from '../../github/index.js';
import { setupWorktree, cleanupWorktree } from '../workspace/index.js';
import { removeTaskActive } from './pool.js';
import { executeAgentCLI } from './cli.js';
import * as tui from '../tui/index.js';

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
 * @why 分散実行時の二重実行防止（排ため制御）を厳密に行うため。
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
 * @what Issueに対応するworktreeを作成し、エージェントCLIを実行して後片付けを行います。
 * @why 隔離環境下でエージェントを安全に実行し、実行完了後に状態を更新するため。
 */
async function executeIssueCLI(taskNumber: string, options: IssueTaskOptions): Promise<boolean> {
  const { repo, agent, issue, config, repoMapMd } = options;
  const branchName = `agent/issue-${issue.number}`;
  let workspacePath = '';
  let success = true;

  try {
    workspacePath = setupWorktree(config, { repo, taskNumber, branchName, isPR: false });
    const context = { repoName: repo, repoMapMd, issue };
    const prompt = agent.buildPrompt(context);

    await executeAgentCLI(config, { agent, prompt, workspacePath, taskNumber });
  } catch (error) {
    success = false;
    logger.error(`Error executing Agent ${agent.id} on Issue #${issue.number}`, 'crawler', error);
  } finally {
    await updateIssueLabels(repo, issue.number, [], ['agent:running']);
    if (workspacePath) {
      cleanupWorktree(repo, taskNumber, config);
    }
    logger.info(
      `\n┌────────────────────────────────────────────────────────────────────────────────` +
        `\n│ <<< Finished Agent: [${agent.id}] on Issue #${issue.number} in ${repo}` +
        `\n│     Status: ${success ? 'SUCCESS' : 'FAILED'}` +
        `\n└────────────────────────────────────────────────────────────────────────────────\n`,
      'crawler',
    );
  }
  return success;
}

/**
 * @what Issueに対するエージェントのライフサイクル全体の実行を制御します。
 * @why ロック確認・獲得、隔離ワークツリー構築、CLI起動、後処理・解除の流れを統合実行するため。
 */
export async function runIssueAgentTask(options: IssueTaskOptions): Promise<void> {
  const { repo, agent, issue } = options;
  const key = `${repo}#${issue.number}-${agent.id}`;

  try {
    const isLocked = await performIssueLockCheck(repo, issue, agent);
    if (isLocked) {
      return;
    }

    logger.info(
      `\n┌────────────────────────────────────────────────────────────────────────────────` +
        `\n│ >>> Starting Agent: [${agent.id}] on Issue #${issue.number} in ${repo}` +
        `\n│     Title: "${issue.title}"` +
        `\n└────────────────────────────────────────────────────────────────────────────────`,
      'crawler',
    );

    await updateIssueLabels(repo, issue.number, ['agent:running'], []);

    const taskNumber = `${issue.number}-${agent.id}`;
    tui.taskStarted(key);
    const success = await executeIssueCLI(taskNumber, options);
    tui.taskFinished(key, success);
  } finally {
    removeTaskActive(key);
  }
}

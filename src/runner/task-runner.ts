import * as path from 'path';
import type { AppConfig, GitHubIssue, GitHubPullRequest } from '../core/index.js';
import type { Agent } from '../agents/index.js';
import { logger, runCommand } from '../core/index.js';
import {
  updateIssueLabels,
  updatePullRequestLabels,
  getIssue,
  getPullRequest,
} from '../github/index.js';
import { setupWorktree, cleanupWorktree } from './workspace.js';
import { removeTaskActive } from './pool.js';
import * as tui from './tui.js';

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
 * @what CLIの実行を構成するための内部パラメータ。
 * @why パラメータ数を減らし、シグネチャを簡素に保つため。
 */
export interface CLIExecutionOptions {
  agent: Agent;
  prompt: string;
  workspacePath: string;
  taskNumber: string;
}

/**
 * @what エージェントフォールバック起動に必要なコンテキスト。
 * @why パラメータ数を削減し、エラーハンドリングを簡素化するため。
 */
interface FallbackOptions {
  config: AppConfig;
  opts: CLIExecutionOptions;
  logFilePath: string;
  onProgress: (line: string) => void;
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
 * @what エージェントCLIの進捗出力をフィルタリングしてコンソールに出力するコールバック関数を生成します。
 * @why 開発進捗をプレフィックス付きで分かりやすくリアルタイムに確認できるようにするため。
 */
function createProgressCallback(repoFolder: string, taskNumber: string, agentId: string) {
  let lastLoggedAction = '';
  const pat = /thinking|calling tool|tool call|executing|tool response|tool result/i;
  return (line: string) => {
    const trimmed = line.trim();
    if (trimmed && pat.test(trimmed) && trimmed !== lastLoggedAction) {
      lastLoggedAction = trimmed;
      logger.info(`[${repoFolder}#${taskNumber} (${agentId})]: ${trimmed}`, 'progress');
    }
  };
}

/**
 * @what CLIの起動失敗エラーをハンドリングし、必要に応じてClaudeへのフォールバック起動を行います。
 * @why Gemini CLI未導入の環境であっても、Claude CLIを用いて処理を継続できるようにするため。
 */
async function handleCLIError(error: unknown, fbOpts: FallbackOptions): Promise<void> {
  const isErrno = (e: unknown): e is { code?: string; message?: string } => {
    return typeof e === 'object' && e !== null;
  };
  const { config, opts, logFilePath, onProgress } = fbOpts;

  if (
    opts.agent.commandType === 'gemini' &&
    isErrno(error) &&
    (error.code === 'ENOENT' || error.message?.includes('ENOENT'))
  ) {
    logger.warn(`Gemini CLI not found. Falling back to Claude CLI.`, 'crawler');
    const runnerArgs = [...config.claudeFlags, '-p', opts.prompt];
    const result = await runCommand({
      cmd: config.claudeCommand,
      args: runnerArgs,
      cwd: opts.workspacePath,
      logFilePath,
      silentStdout: true,
      onProgress,
    });
    logger.debug(
      `Agent ${opts.agent.id} CLI (fallback) completed with exit code: ${result.code}`,
      'crawler',
    );
  } else {
    throw error;
  }
}

/**
 * @what 指定されたエージェントの指示プロンプトを引数として LLM CLI に渡し、実行を開始します。
 * @why 複数行に及ぶプロンプトを安全に引き渡し、進捗出力をフィルタリングしてコンソールに表示するため。
 */
export async function executeAgentCLI(config: AppConfig, opts: CLIExecutionOptions): Promise<void> {
  const { agent, prompt, workspacePath, taskNumber } = opts;
  const isClaude = agent.commandType === 'claude';
  const cmd = isClaude ? config.claudeCommand : config.geminiCommand;
  const flags = isClaude ? config.claudeFlags : config.geminiFlags;

  logger.info(`Invoking CLI (${agent.commandType}) for Agent: ${agent.id}...`, 'crawler');

  const runnerArgs = [...flags, '-p', prompt];
  const repoFolder = path.basename(path.dirname(workspacePath));
  const logFilePath = path.resolve(
    config.workspacesDir,
    repoFolder,
    'logs',
    `task-${taskNumber}.log`,
  );

  const onProgress = createProgressCallback(repoFolder, taskNumber, agent.id);

  try {
    const result = await runCommand({
      cmd,
      args: runnerArgs,
      cwd: workspacePath,
      logFilePath,
      silentStdout: true,
      onProgress,
    });
    logger.debug(`Agent ${agent.id} CLI completed with exit code: ${result.code}`, 'crawler');
  } catch (error) {
    await handleCLIError(error, { config, opts, logFilePath, onProgress });
  }
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

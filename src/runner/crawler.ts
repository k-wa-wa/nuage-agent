import * as path from 'path';
import * as fs from 'fs';
import type { AppConfig, GitHubIssue, GitHubPullRequest } from '../core/index.js';
import { logger, runCommand } from '../core/index.js';
import type { Agent, AgentContext } from '../agents/index.js';
import { agentsList, QAGeneratorAgent } from '../agents/index.js';
import {
  getIssueComments,
  updateIssueLabels,
  updatePullRequestLabels,
  getViewerLogin,
  getIssue,
  getPullRequest,
  getRecentIssues,
  getAllOpenIssues,
  getAllOpenPRs,
} from './github-client.js';
import { setupWorktree, cleanupWorktree } from './workspace.js';
import {
  conflictPool,
  nonConflictPool,
  isTaskActive,
  addTaskActive,
  removeTaskActive,
} from './pool.js';

function isConflictAgent(agentId: string): boolean {
  return agentId === 'dev' || agentId === 'dev-pr' || agentId === 'qa';
}

/**
 * @what 監視対象リポジトリ群を定期ポーリングし、agent:* ラベルをトリガーに適切なエージェントを並行して呼び出すクローラークラスです。
 * @why 各フェーズ（spec→dev→review→qa）の自律エージェントを、ポート競合の有無に基づいた並行プールに振り分けて効率的に実行するため。
 */
export class PipelineCrawler {
  private config: AppConfig;
  private isRunning = false;

  constructor(config: AppConfig) {
    this.config = {
      ...config,
      claudeCommand: config.claudeCommand.startsWith('~/')
        ? config.claudeCommand.replace('~', process.env.HOME ?? '')
        : config.claudeCommand,
      geminiCommand: config.geminiCommand.startsWith('~/')
        ? config.geminiCommand.replace('~', process.env.HOME ?? '')
        : config.geminiCommand,
    };
  }

  /**
   * @what repo-map ディレクトリから対象リポジトリ用の Markdown マップファイルを直接同期的に読み込みます。
   * @why エージェント（Claude Code 等）がコードを修正する前に、対象 codebase の全体ディレクトリ構成や規約、コンパイルルールなどをコンテキストに結合して賢く判断させるため。
   */
  private getRepoMapMd(repo: string): string {
    const repoFolder = repo.split('/').pop() ?? repo;
    const mdPath = path.join(this.config.repoMapDir, `${repoFolder}.md`);

    if (fs.existsSync(mdPath)) {
      logger.debug(`Loaded repo-map from ${mdPath}`, 'crawler');
      return fs.readFileSync(mdPath, 'utf-8');
    }

    logger.warn(`No repo-map markdown file found at ${mdPath}`, 'crawler');
    return `リポジトリ "${repo}" の構造マップ（ディレクトリ構成、技術スタック、規約など）は未定義です。一般的なTypeScriptプロジェクトとして対応してください。`;
  }

  /**
   * @what 監視対象リポジトリ群に対して、Issue/PRの定期的な状態チェック巡回（1サイクル）を実行します。
   * @why 定期的に GitHub の更新をポーリングし、新しい `agent:*` ラベルをトリガーにして適切な自律エージェントを連続して呼び出すため。
   */
  public async crawlCycle(): Promise<void> {
    if (this.isRunning) {
      logger.info('Previous crawl cycle still running. Skipping...', 'crawler');
      return;
    }

    this.isRunning = true;
    logger.info(
      `\n========================================= [Crawl Cycle Start] =========================================`,
      'crawler',
    );

    try {
      for (const repo of this.config.repositories) {
        logger.info(`Checking repository: ${repo}`, 'crawler');

        // Fetch open issues and PRs once per repository
        const openIssues = await getAllOpenIssues(repo);
        const openPRs = await getAllOpenPRs(repo);

        // Resolve 'agent:wait' locks if there are new user comments
        await this.handleWaitingIssues(repo, openIssues);

        // Run Proactive QA Generator Agent check
        await this.runProactiveQAGenerator(repo);

        // Loop through each registered agent in the interface list
        for (const agent of agentsList) {
          logger.debug(`Running check for Agent: ${agent.id} (label: ${agent.label})`, 'crawler');

          if (agent.targetType === 'issue') {
            this.processIssueAgent(repo, agent, openIssues);
          } else {
            this.processPRAgent(repo, agent, openPRs);
          }
        }

        // Post-review check: If a PR is labeled 'agent:review' and both reviewers have approved,
        // elevate state to 'agent:qa'
        await this.postReviewCheck(repo, openPRs);
      }

      // Wait for all tasks enqueued in this cycle to complete
      await Promise.all([conflictPool.waitForCompletion(), nonConflictPool.waitForCompletion()]);
    } catch (error) {
      logger.error('Error during crawl cycle', 'crawler', error);
    } finally {
      this.isRunning = false;
      logger.info(
        `========================================= [Crawl Cycle End] =========================================\n`,
        'crawler',
      );
    }
  }

  /**
   * @what Issue をターゲットとするエージェント（仕様定義・開発）のチェックおよび実行プロセスをハンドリングします。
   * @why `agent:spec` や `agent:dev` ラベルがついた未ロックの課題に対して、リポジトリマップ情報と過去のコメント履歴をプロンプトに組み立て、CLIを起動してタスクを解決するため。
   */
  private processIssueAgent(repo: string, agent: Agent, openIssues: GitHubIssue[]): void {
    const issues = openIssues.filter((issue) => issue.labels.includes(agent.label));

    for (const issue of issues) {
      if (issue.labels.includes('agent:running')) {
        continue;
      }
      if (issue.labels.includes('agent:wait')) {
        continue;
      }

      const key = `${repo}#${issue.number}-${agent.id}`;
      if (isTaskActive(key)) {
        logger.debug(`Task ${key} is already active/queued. Skipping.`, 'crawler');
        continue;
      }
      addTaskActive(key);

      const pool = isConflictAgent(agent.id) ? conflictPool : nonConflictPool;
      pool.enqueue(async () => {
        try {
          // --- STRICT LOCK CHECK ---
          const freshIssue = await getIssue(repo, issue.number);
          if (!freshIssue) {
            logger.warn(
              `Skipping Issue #${issue.number} because it could not be fetched fresh.`,
              'crawler',
            );
            return;
          }
          if (freshIssue.labels.includes('agent:running')) {
            logger.info(
              `Skipping Issue #${issue.number} because it was locked by another process (agent:running detected).`,
              'crawler',
            );
            return;
          }
          if (freshIssue.labels.includes('agent:wait')) {
            logger.info(
              `Skipping Issue #${issue.number} because agent:wait was recently added.`,
              'crawler',
            );
            return;
          }
          if (!freshIssue.labels.includes(agent.label)) {
            logger.info(
              `Skipping Issue #${issue.number} because the target label "${agent.label}" was removed.`,
              'crawler',
            );
            return;
          }

          logger.info(
            `\n┌────────────────────────────────────────────────────────────────────────────────` +
              `\n│ >>> Starting Agent: [${agent.id}] on Issue #${issue.number} in ${repo}` +
              `\n│     Title: "${issue.title}"` +
              `\n└────────────────────────────────────────────────────────────────────────────────`,
            'crawler',
          );

          // Lock the issue
          await updateIssueLabels(repo, issue.number, ['agent:running'], []);

          const taskNumber = `${issue.number}-${agent.id}`;
          const branchName = `agent/issue-${issue.number}`;
          let workspacePath = '';
          let success = true;
          try {
            workspacePath = setupWorktree(repo, taskNumber, branchName, false, this.config);
            const repoMapMd = this.getRepoMapMd(repo);

            const context: AgentContext = {
              repoName: repo,
              repoMapMd,
              issue,
            };

            const prompt = agent.buildPrompt(context);

            // Execute CLI
            await this.executeAgentCLI(agent, prompt, workspacePath, taskNumber);
          } catch (error) {
            success = false;
            logger.error(
              `Error executing Agent ${agent.id} on Issue #${issue.number}`,
              'crawler',
              error,
            );
          } finally {
            // Unlock the issue
            await updateIssueLabels(repo, issue.number, [], ['agent:running']);
            if (workspacePath) {
              cleanupWorktree(repo, taskNumber, this.config);
            }
            logger.info(
              `\n┌────────────────────────────────────────────────────────────────────────────────` +
                `\n│ <<< Finished Agent: [${agent.id}] on Issue #${issue.number} in ${repo}` +
                `\n│     Status: ${success ? 'SUCCESS' : 'FAILED'}` +
                `\n└────────────────────────────────────────────────────────────────────────────────\n`,
              'crawler',
            );
          }
        } finally {
          removeTaskActive(key);
        }
      });
    }
  }

  /**
   * @what プルリクエストをターゲットとするエージェント（レビュー、QA）のチェックおよび実行プロセスをハンドリングします。
   * @why 作成されたPRブランチに紐づくコード差分やテスト結果に基づき、レビュー指摘コメントの投稿やQAテストの自動実行を安全なワークスペース上で行うため。
   */
  private processPRAgent(repo: string, agent: Agent, openPRs: GitHubPullRequest[]): void {
    const prs = openPRs.filter((pr) => pr.labels.includes(agent.label));

    for (const pr of prs) {
      if (pr.labels.includes('agent:running')) {
        continue;
      }

      const key = `${repo}#${pr.number}-${agent.id}`;
      if (isTaskActive(key)) {
        logger.debug(`Task ${key} is already active/queued. Skipping.`, 'crawler');
        continue;
      }
      addTaskActive(key);

      const pool = isConflictAgent(agent.id) ? conflictPool : nonConflictPool;
      pool.enqueue(async () => {
        try {
          // --- STRICT LOCK CHECK ---
          const freshPR = await getPullRequest(repo, pr.number);
          if (!freshPR) {
            logger.warn(
              `Skipping PR #${pr.number} because it could not be fetched fresh.`,
              'crawler',
            );
            return;
          }
          if (freshPR.labels.includes('agent:running')) {
            logger.info(
              `Skipping PR #${pr.number} because it was locked by another process (agent:running detected).`,
              'crawler',
            );
            return;
          }
          if (!freshPR.labels.includes(agent.label)) {
            logger.info(
              `Skipping PR #${pr.number} because the target label "${agent.label}" was removed.`,
              'crawler',
            );
            return;
          }

          logger.info(
            `\n┌────────────────────────────────────────────────────────────────────────────────` +
              `\n│ >>> Starting Agent: [${agent.id}] on PR #${pr.number} in ${repo}` +
              `\n│     Title: "${pr.title}"` +
              `\n└────────────────────────────────────────────────────────────────────────────────`,
            'crawler',
          );

          // Lock the PR
          await updatePullRequestLabels(repo, pr.number, ['agent:running'], []);

          const taskNumber = `${pr.number}-${agent.id}`;
          let workspacePath = '';
          let success = true;
          try {
            workspacePath = setupWorktree(repo, taskNumber, pr.branch, true, this.config);
            const repoMapMd = this.getRepoMapMd(repo);

            const context: AgentContext = {
              repoName: repo,
              repoMapMd,
              pr,
              autoMerge: this.config.qaAutoMerge,
            };

            const prompt = agent.buildPrompt(context);

            // Execute CLI
            await this.executeAgentCLI(agent, prompt, workspacePath, taskNumber);
          } catch (error) {
            success = false;
            logger.error(`Error executing Agent ${agent.id} on PR #${pr.number}`, 'crawler', error);
          } finally {
            // Unlock the PR
            await updatePullRequestLabels(repo, pr.number, [], ['agent:running']);
            if (workspacePath) {
              cleanupWorktree(repo, taskNumber, this.config);
            }
            logger.info(
              `\n┌────────────────────────────────────────────────────────────────────────────────` +
                `\n│ <<< Finished Agent: [${agent.id}] on PR #${pr.number} in ${repo}` +
                `\n│     Status: ${success ? 'SUCCESS' : 'FAILED'}` +
                `\n└────────────────────────────────────────────────────────────────────────────────\n`,
              'crawler',
            );
          }
        } finally {
          removeTaskActive(key);
        }
      });
    }
  }

  /**
   * @what 指定されたエージェントの指示プロンプトを引数（-p）として LLM CLI（Claude/Gemini）に渡し、実行を開始します。
   * @why 複数行に及ぶプロンプトを安全に引き渡し、さらに進捗出力をリアルタイムでユーザーのコンソールにストリームするため。
   */
  private async executeAgentCLI(
    agent: Agent,
    prompt: string,
    workspacePath: string,
    taskNumber: string,
  ): Promise<void> {
    const isClaude = agent.commandType === 'claude';
    let cmd = isClaude ? this.config.claudeCommand : this.config.geminiCommand;
    let flags = isClaude ? this.config.claudeFlags : this.config.geminiFlags;
    let commandType = agent.commandType;

    logger.info(`Invoking CLI (${commandType}) for Agent: ${agent.id}...`, 'crawler');

    // Aligned to pass prompt as an argument to the '-p' flag directly
    let runnerArgs = [...flags, '-p', prompt];

    const repoFolder = path.basename(path.dirname(workspacePath));
    const logFilePath = path.resolve(
      this.config.workspacesDir,
      repoFolder,
      'logs',
      `task-${taskNumber}.log`,
    );

    let lastLoggedAction = '';
    const progressPatterns = [
      /thinking/i,
      /calling tool/i,
      /tool call/i,
      /executing/i,
      /tool response/i,
      /tool result/i,
    ];
    const onProgress = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return;
      }
      if (progressPatterns.some((pat) => pat.test(trimmed))) {
        if (trimmed !== lastLoggedAction) {
          lastLoggedAction = trimmed;
          logger.info(`[${repoFolder}#${taskNumber} (${agent.id})]: ${trimmed}`, 'progress');
        }
      }
    };

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
      const isErrnoException = (e: unknown): e is { code?: string; message?: string } => {
        return typeof e === 'object' && e !== null;
      };

      if (
        commandType === 'gemini' &&
        isErrnoException(error) &&
        (error.code === 'ENOENT' || error.message?.includes('ENOENT'))
      ) {
        logger.warn(
          `Gemini CLI ("${cmd}") not found. Falling back to Claude CLI ("${this.config.claudeCommand}").`,
          'crawler',
        );
        cmd = this.config.claudeCommand;
        flags = this.config.claudeFlags;
        commandType = 'claude';
        runnerArgs = [...flags, '-p', prompt];

        logger.info(
          `Invoking CLI (${commandType}) for Agent: ${agent.id} (fallback)...`,
          'crawler',
        );
        const result = await runCommand({
          cmd,
          args: runnerArgs,
          cwd: workspacePath,
          logFilePath,
          silentStdout: true,
          onProgress,
        });
        logger.debug(`Agent ${agent.id} CLI completed with exit code: ${result.code}`, 'crawler');
      } else {
        throw error;
      }
    }
  }

  /**
   * @what 2つのコードレビューエージェント（一般および意味的チェック）によるレビュー合格結果を確認し、状態をQAへと昇格させます。
   * @why それぞれ非同期で完了するレビューエージェントの出力を統合監視し、双方とも `PASSED` を報告した場合のみ自動的に次の `agent:qa` ラベルへ安全に移行させるため。
   */
  private async postReviewCheck(repo: string, openPRs: GitHubPullRequest[]): Promise<void> {
    const prs = openPRs.filter((pr) => pr.labels.includes('agent:review'));

    for (const pr of prs) {
      if (pr.labels.includes('agent:running')) {
        continue;
      }

      // Query PR review comments / statuses
      // For now, check if reviewers left approval comments (meaning no further actions)
      const comments = await getIssueComments(repo, pr.number);
      const botUser = await getViewerLogin();

      // Check if both general and semantic reviewers approved
      const hasGeneralPassed = comments.some(
        (c) => c.user === botUser && c.body.includes('[General Review Result: PASSED]'),
      );
      const hasSemanticPassed = comments.some(
        (c) => c.user === botUser && c.body.includes('[Semantic Review Result: PASSED]'),
      );

      if (hasGeneralPassed && hasSemanticPassed) {
        logger.info(`PR #${pr.number} passed all review checks. Elevating to QA phase.`, 'crawler');
        await updatePullRequestLabels(repo, pr.number, ['agent:qa'], ['agent:review']);
      }
    }
  }

  /**
   * @what 'agent:wait' (保留中) ラベルが付いているIssueにおいて、新着コメントが自分以外のユーザー（または別Bot）から投稿されたかを検知し、ラベルを自動解除します。
   * @why ユーザーがコメントで返答した際に、手動でラベルを剥がす手間を省き、自動的にエージェント実行サイクルを再開させるため。
   */
  private async handleWaitingIssues(repo: string, openIssues: GitHubIssue[]): Promise<void> {
    const waitingIssues = openIssues.filter((issue) => issue.labels.includes('agent:wait'));
    if (waitingIssues.length === 0) {
      return;
    }

    const currentBotUser = await getViewerLogin();

    for (const issue of waitingIssues) {
      const comments = await getIssueComments(repo, issue.number);
      if (comments.length > 0) {
        const latestComment = comments[comments.length - 1];
        // If someone else (user or another bot) commented, remove the wait label to resume pipeline
        if (latestComment.user !== currentBotUser) {
          logger.info(
            `Detected new comment from user/other-bot on Issue #${issue.number}. Removing 'agent:wait' label.`,
            'crawler',
          );
          await updateIssueLabels(repo, issue.number, [], ['agent:wait']);
        }
      }
    }
  }

  /**
   * @what 定期的なQA改善Issue自動起票（プロアクティブエージェント）の実行チェックを行います。
   * @why テスト不足箇所の拡充やLint改善を完全自動で小さく積み重ねるため、前回の起票から指定時間（テスト時10分/本番1日等）が経過し、かつ現在オープン中のQA改善Issueがない場合に起票エージェントを起動します。
   */
  private async runProactiveQAGenerator(repo: string): Promise<void> {
    const intervalMinutes = this.config.qaIssueIntervalMinutes;
    const prefix = this.config.qaIssuePrefix;

    if (intervalMinutes <= 0) {
      return;
    }

    logger.debug(`Checking proactive QA Generator for ${repo}...`, 'crawler');

    // 1. Get recent issues with the prefix
    const recentIssues = await getRecentIssues(repo);
    const qaIssues = recentIssues.filter((issue) => issue.title.startsWith(prefix));

    // Check if there is an open QA issue
    const hasOpenQAIssue = qaIssues.some((issue) => issue.state.toLowerCase() === 'open');
    if (hasOpenQAIssue) {
      logger.info(
        `Skipping QA issue generation: An open issue with prefix "${prefix}" already exists.`,
        'crawler',
      );
      return;
    }

    // Check time elapsed since the last QA issue was created
    if (qaIssues.length > 0) {
      // Sort issues by creation date descending
      qaIssues.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const latestIssue = qaIssues[0];
      const latestCreatedAt = new Date(latestIssue.createdAt).getTime();
      const now = new Date().getTime();
      const elapsedMinutes = (now - latestCreatedAt) / (1000 * 60);

      if (elapsedMinutes < intervalMinutes) {
        logger.info(
          `Skipping QA issue generation: Only ${elapsedMinutes.toFixed(1)} minutes elapsed since the last issue was created (Interval: ${intervalMinutes} minutes).`,
          'crawler',
        );
        return;
      }
    }

    const key = `${repo}#qa-generator`;
    if (isTaskActive(key)) {
      logger.debug(`QA Generator task for ${repo} is already active/queued. Skipping.`, 'crawler');
      return;
    }
    addTaskActive(key);

    nonConflictPool.enqueue(async () => {
      logger.info(
        `Starting Proactive QA Generator Agent (QAGeneratorAgent) for ${repo}...`,
        'crawler',
      );

      const taskNumber = 'qa-generator';
      let workspacePath = '';
      try {
        const branchName = 'agent/qa-generator';
        workspacePath = setupWorktree(repo, taskNumber, branchName, false, this.config);
        const repoMapMd = this.getRepoMapMd(repo);

        const context: AgentContext = {
          repoName: repo,
          repoMapMd,
        };

        const agent = new QAGeneratorAgent(prefix);
        const prompt = agent.buildPrompt(context);

        // Execute Agent CLI (Claude) in workspace
        await this.executeAgentCLI(agent, prompt, workspacePath, taskNumber);
        logger.success(`QA Generator Agent completed successfully.`, 'crawler');
      } catch (error) {
        logger.error(`Failed to run QA Generator Agent on ${repo}`, 'crawler', error);
      } finally {
        if (workspacePath) {
          cleanupWorktree(repo, taskNumber, this.config);
        }
        removeTaskActive(key);
      }
    });
  }
}

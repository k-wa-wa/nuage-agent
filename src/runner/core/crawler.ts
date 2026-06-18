import * as path from 'path';
import * as fs from 'fs';
import type { AppConfig, GitHubIssue, GitHubPullRequest } from '../../core/index.js';
import type { Agent } from '../../agents/index.js';
import { agentsList } from '../../agents/index.js';
import { logger } from '../../core/index.js';
import * as tui from '../tui/index.js';
import {
  getIssueComments,
  updatePullRequestLabels,
  getViewerLogin,
  getRecentIssues,
  getAllOpenIssues,
  getAllOpenPRs,
} from '../../github/index.js';
import { conflictPool, nonConflictPool, isTaskActive, addTaskActive } from '../tasks/pool.js';
import { runIssueAgentTask } from '../tasks/issue.js';
import { runPRAgentTask } from '../tasks/pr.js';
import { runQAGeneratorTask } from '../tasks/qa.js';

/**
 * @what エージェントが並行プールで競合を引き起こすかどうかを判定します。
 * @why テスト実行を行う重いタスク（dev, qa）をシリアルプールに割り当てるため。
 */
function isConflictAgent(agentId: string): boolean {
  return agentId === 'dev' || agentId === 'qa';
}

/**
 * @what 監視対象リポジトリ群を定期ポーリングし、agent:* ラベルをトリガーに適切なエージェントをディスパッチするクローラークラス。
 * @why 状態監視とディスパッチに専念し、詳細な実行処理は TaskRunner に委譲してコードをシンプルに保つため。
 */
export class PipelineCrawler {
  /**
   * @what ランナーの設定情報。
   * @why クローンディレクトリやコマンド実行オプションなどを参照するため。
   */
  private config: AppConfig;

  /**
   * @what 現在クローラーが巡回中かどうかのフラグ。
   * @why 多重巡回の発生を防ぐため。
   */
  private isRunning = false;

  /**
   * @what 指定された設定情報で PipelineCrawler を初期化します。
   * @why 各種LLMのCLIパスや監視対象リポジトリの一覧を設定するため。
   */
  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * @what repo-map ディレクトリから対象リポジトリ用の Markdown マップファイルを直接同期的に読み込みます。
   * @why エージェント（Claude Code 等）がコードを修正する前に、対象 codebase の全体構成をコンテキストに結合して賢く判断させるため。
   */
  private getRepoMapMd(repo: string): string {
    const repoFolder = repo.split('/').pop() ?? repo;
    const mdPath = path.join(this.config.repoMapDir, `${repoFolder}.md`);

    if (fs.existsSync(mdPath)) {
      logger.debug(`Loaded repo-map from ${mdPath}`, 'crawler');
      return fs.readFileSync(mdPath, 'utf-8');
    }

    logger.warn(`No repo-map markdown file found at ${mdPath}`, 'crawler');
    return `リポジトリ "${repo}" の構造マップは未定義です。一般的なTypeScriptプロジェクトとして対応してください。`;
  }

  /**
   * @what 登録された各リポジトリについて、Issue/PRのフェッチとエージェント振り分け処理を行います。
   * @why 複数リポジトリの走査と大枠の例外処理を切り分けるため。
   */
  private async runCycleForEachRepo(): Promise<void> {
    for (const repo of this.config.repositories) {
      logger.info(`Checking repository: ${repo}`, 'crawler');

      const openIssues = await getAllOpenIssues(repo);
      const openPRs = await getAllOpenPRs(repo);

      await this.handleWaitingIssues(repo, openIssues);
      await this.runProactiveQAGenerator(repo);

      for (const agent of agentsList) {
        logger.debug(`Running check for Agent: ${agent.id} (label: ${agent.label})`, 'crawler');

        if (agent.targetType === 'issue') {
          this.processIssueAgent(repo, agent, openIssues);
        } else {
          this.processPRAgent(repo, agent, openPRs);
        }
      }
    }
  }

  /**
   * @what 監視対象リポジトリ群に対して、Issue/PRの定期的な状態チェック巡回（1サイクル）を実行します。
   * @why 定期的に GitHub の更新をポーリングし、新しい `agent:*` ラベルをトリガーにして適切な自律エージェントを連続して呼び出すため。
   */
  public async crawlCycle(): Promise<void> {
    tui.setRepos(this.config.repositories);
    tui.setLastCrawlTime(new Date());

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
      await this.runCycleForEachRepo();

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
   * @what Issue をターゲットとするエージェント（仕様定義・開発）のチェックおよび並行キュー登録を行います。
   * @why `agent:spec` や `agent:dev` ラベルがついた未ロックの課題に対して、ディスパッチを実行するため。
   */
  private processIssueAgent(repo: string, agent: Agent, openIssues: GitHubIssue[]): void {
    const issues = openIssues.filter((issue) => issue.labels.includes(agent.label));

    for (const issue of issues) {
      if (issue.labels.includes('agent:running') || issue.labels.includes('agent:wait')) {
        continue;
      }

      const key = `${repo}#${issue.number}-${agent.id}`;
      if (isTaskActive(key)) {
        logger.debug(`Task ${key} is already active/queued. Skipping.`, 'crawler');
        continue;
      }
      addTaskActive(key);
      tui.taskQueued(key, repo, `Agent: ${agent.id} on Issue #${issue.number}`);

      const pool = isConflictAgent(agent.id) ? conflictPool : nonConflictPool;
      const repoMapMd = this.getRepoMapMd(repo);
      pool.enqueue(() => runIssueAgentTask({ repo, agent, issue, config: this.config, repoMapMd }));
    }
  }

  /**
   * @what プルリクエストをターゲットとするエージェント（レビュー、QA）のチェックおよび並行キュー登録を行います。
   * @why レビュー指摘コメントの投稿やQAテストを並行環境にディスパッチして自動実行させるため。
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
      tui.taskQueued(key, repo, `Agent: ${agent.id} on PR #${pr.number}`);

      const pool = isConflictAgent(agent.id) ? conflictPool : nonConflictPool;
      const repoMapMd = this.getRepoMapMd(repo);
      pool.enqueue(() => runPRAgentTask({ repo, agent, pr, config: this.config, repoMapMd }));
    }
  }

  /**
   * @what 'agent:wait' (保留中) ラベルが付いているIssueにおいて、新着コメントが自分以外のユーザー（または別Bot）から投稿されたかを検知し、ラベルを自動解除します。
   * @why ユーザーがコメントで返答した際に、自動的にエージェント実行サイクルを再開させるため。
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
        if (latestComment.user !== currentBotUser) {
          logger.info(
            `Detected new comment from user/other-bot on Issue #${issue.number}. Removing 'agent:wait' label.`,
            'crawler',
          );
          await updatePullRequestLabels(repo, issue.number, [], ['agent:wait']);
        }
      }
    }
  }

  /**
   * @what プロアクティブQA改善課題を起票する条件（既存のオープン課題がない、前回の起票から指定時間経過しているなど）を満たすか確認します。
   * @why 無駄なAPI起票や短時間での重複起票を防ぐため。
   */
  private async checkProactiveEligibility(
    repo: string,
    prefix: string,
    intervalMinutes: number,
  ): Promise<boolean> {
    const recentIssues = await getRecentIssues(repo);
    const qaIssues = recentIssues.filter((issue) => issue.title.startsWith(prefix));

    const hasOpenQAIssue = qaIssues.some((issue) => issue.state.toLowerCase() === 'open');
    if (hasOpenQAIssue) {
      logger.info(
        `Skipping QA issue generation: open issue with prefix "${prefix}" exists.`,
        'crawler',
      );
      return false;
    }

    if (qaIssues.length > 0) {
      qaIssues.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
      const elapsedMinutes =
        (new Date().getTime() - new Date(qaIssues[0].createdAt).getTime()) / (1000 * 60);

      if (elapsedMinutes < intervalMinutes) {
        logger.info(
          `Skipping QA issue generation: only ${elapsedMinutes.toFixed(1)}m elapsed (interval: ${intervalMinutes}m).`,
          'crawler',
        );
        return false;
      }
    }
    return true;
  }

  /**
   * @what 定期的なQA改善Issue自動起票（プロアクティブエージェント）の実行チェックとプールへの投入を行います。
   * @why テスト不足箇所の起票エージェントを自動分析・非同期で起動させるため。
   */
  private async runProactiveQAGenerator(repo: string): Promise<void> {
    const intervalMinutes = this.config.qaIssueIntervalMinutes;
    const prefix = this.config.qaIssuePrefix;

    if (intervalMinutes <= 0) {
      return;
    }

    logger.debug(`Checking proactive QA Generator for ${repo}...`, 'crawler');

    const isEligible = await this.checkProactiveEligibility(repo, prefix, intervalMinutes);
    if (!isEligible) {
      return;
    }

    const key = `${repo}#qa-generator`;
    if (isTaskActive(key)) {
      logger.debug(`QA Generator task for ${repo} is already active/queued. Skipping.`, 'crawler');
      return;
    }
    addTaskActive(key);

    const repoMapMd = this.getRepoMapMd(repo);
    nonConflictPool.enqueue(() =>
      runQAGeneratorTask({ repo, config: this.config, repoMapMd, prefix }),
    );
  }
}

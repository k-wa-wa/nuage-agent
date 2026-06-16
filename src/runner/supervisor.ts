import type { AppConfig } from '../core/index.js';
import {
  logger,
  getIssuesWithLabel,
  updateIssueLabels,
  getPullRequestsWithLabel,
  updatePullRequestLabels,
  getRawIssues,
  getRawPRs,
  addIssueComment,
  addPullRequestComment,
} from '../core/index.js';

interface RawIssueSummary {
  number: number;
  title: string;
  labels: { name: string }[];
}

interface RawPRSummary {
  number: number;
  title: string;
  body: string;
  headRefName: string;
}

/**
 * @what 単一のIssueについて、プレフィックスラベルが無い場合に自動トリアージを行い、コメントを投稿します。
 * @why タスクの新規起票からワークフローの乗せ換えまでを完全に自動化するため。
 */
async function triageSingleIssue(
  repo: string,
  item: RawIssueSummary,
  prs: RawPRSummary[],
): Promise<void> {
  const labels = item.labels.map((l) => l.name);
  const hasAgentLabel = labels.some((l) => l.startsWith('agent:'));
  if (hasAgentLabel) {
    return;
  }

  const hasActivePR = prs.some((pr) => {
    const issueRefRegex = new RegExp(`\\b#${item.number}\\b`);
    const branchNameRef = `issue-${item.number}`;
    return (
      issueRefRegex.test(pr.title) ||
      issueRefRegex.test(pr.body || '') ||
      pr.headRefName.includes(branchNameRef)
    );
  });

  if (hasActivePR) {
    logger.info(
      `Issue #${item.number} has no agent:* labels but has active PR referencing it. Skipping auto-assigning agent:spec.`,
      'supervisor',
    );
    return;
  }

  logger.info(`Unlabeled Issue #${item.number} found. Assigning agent:spec...`, 'supervisor');
  await updateIssueLabels(repo, item.number, ['agent:spec'], []);

  const commentBody = `🤖 **Supervisor**: 新しい課題が検知されました。自動開発ワークフローを開始するため、仕様定義エージェント (\`agent:spec\`) を自動で割り当てます。壁打ち対話の開始をお待ちください。`;
  try {
    await addIssueComment(repo, item.number, commentBody);
  } catch (error) {
    logger.error(`Failed to post comment on Issue #${item.number}`, 'supervisor', error);
  }
}

/**
 * @what GitHub Issue/PRパイプラインのフリーズ・未ラベル状態を監視し、タイムアウト・自動トリアージ・agent:wait解除を行う監視者クラスです。
 * @why CrawlerがアクティブなIssueを処理する一方、スタック・放置されたタスクを救済する役割を担い、ワークフロー全体の詰まりを防止するため。
 */
export class PipelineSupervisor {
  private config: AppConfig;
  private timeoutLimitMs = 15 * 60 * 1000; // 15 minutes

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * @what 監視デーモンの起動時にバックグラウンドで実行され、タイムアウトしたタスクや未分類Issueの修復・トリアージを一括実行します。
   * @why 実行時エラーやCLIフリーズによってフリーズしたプロセスを自動回復させ、開発のスタックを完全に防止するため。
   */
  public async runSupervisorChecks(): Promise<void> {
    logger.info('Starting Supervisor checks...', 'supervisor');
    try {
      for (const repo of this.config.repositories) {
        await this.recoverStuckIssues(repo);
        await this.recoverStuckPRs(repo);
        await this.triageUnlabeledIssues(repo);
      }
    } catch (error) {
      logger.error('Error during Supervisor checks', 'supervisor', error);
    }
    logger.info('Supervisor checks completed.', 'supervisor');
  }

  /**
   * @what 'agent:running' ラベルがついた状態のまま、更新がなく15分以上経過したフリーズ状態のIssueを検知してロックを解除します。
   * @why CLIのネットワーク問題や内部無限ループなどによるリソースロックを解除し、自動的に `agent:triage`（手動介入待ち）に回すことでワークフローを復旧するため。
   */
  private async recoverStuckIssues(repo: string): Promise<void> {
    const runningIssues = await getIssuesWithLabel(repo, 'agent:running');
    const now = new Date().getTime();

    for (const issue of runningIssues) {
      const updatedAt = new Date(issue.updatedAt).getTime();
      const timeElapsed = now - updatedAt;

      if (timeElapsed > this.timeoutLimitMs) {
        logger.warn(
          `Stuck lock detected on Issue #${issue.number} in ${repo} (Last updated: ${issue.updatedAt})`,
          'supervisor',
        );

        await updateIssueLabels(
          repo,
          issue.number,
          ['agent:triage'],
          ['agent:running', 'agent:spec', 'agent:dev', 'agent:review', 'agent:qa'],
        );

        const commentBody = `⚠️ **Supervisor Alert**: このタスクの実行が15分以上停止していたため、自動実行ロックを解除して状態を \`agent:triage\` (人間による調査) に移行しました。`;
        try {
          await addIssueComment(repo, issue.number, commentBody);
          logger.success(`Posted timeout alert comment on Issue #${issue.number}`, 'supervisor');
        } catch (error) {
          logger.error(`Failed to post comment on Issue #${issue.number}`, 'supervisor', error);
        }
      }
    }
  }

  /**
   * @what 'agent:running' ラベルがついた状態のまま、更新がなく15分以上経過したフリーズ状態のPRを検知してロックを解除します。
   * @why レビューやQA実行中にハングしたPRタスクを自動で検知して `agent:triage` に移行させ、全体の進捗が停滞するのを防ぐため。
   */
  private async recoverStuckPRs(repo: string): Promise<void> {
    const runningPRs = await getPullRequestsWithLabel(repo, 'agent:running');
    const now = new Date().getTime();

    for (const pr of runningPRs) {
      const updatedAt = new Date(pr.updatedAt).getTime();
      const timeElapsed = now - updatedAt;

      if (timeElapsed > this.timeoutLimitMs) {
        logger.warn(
          `Stuck lock detected on PR #${pr.number} in ${repo} (Last updated: ${pr.updatedAt})`,
          'supervisor',
        );

        await updatePullRequestLabels(
          repo,
          pr.number,
          ['agent:triage'],
          ['agent:running', 'agent:spec', 'agent:dev', 'agent:review', 'agent:qa'],
        );

        const commentBody = `⚠️ **Supervisor Alert**: このプルリクエストのレビューまたはテスト実行が15分以上停止していたため、自動実行ロックを解除して状態を \`agent:triage\` (人間による調査) に移行しました。`;
        try {
          await addPullRequestComment(repo, pr.number, commentBody);
          logger.success(`Posted timeout alert comment on PR #${pr.number}`, 'supervisor');
        } catch (error) {
          logger.error(`Failed to post comment on PR #${pr.number}`, 'supervisor', error);
        }
      }
    }
  }

  /**
   * @what `agent:` 系のプレフィックスがついたラベルが一切付与されていない新規オープンされたIssueを検知し、自動で `agent:spec` ラベルを貼ります。
   * @why 新しい課題がGitHub上に起票された際、人間が手動でラベルを割り当てることなく、自動的にパイプラインの初期フェーズ（仕様定義）に乗せるため。
   */
  private async triageUnlabeledIssues(repo: string): Promise<void> {
    try {
      const issues = await getRawIssues(repo);
      let prs: RawPRSummary[] = [];
      try {
        prs = await getRawPRs(repo);
      } catch (prError) {
        logger.error(`Failed to fetch pull requests in ${repo}`, 'supervisor', prError);
      }

      for (const item of issues) {
        await triageSingleIssue(repo, item, prs);
      }
    } catch (error) {
      logger.error(`Failed to triage unlabeled issues in ${repo}`, 'supervisor', error);
    }
  }
}

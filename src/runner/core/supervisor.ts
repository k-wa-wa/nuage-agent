import type { AppConfig, GitHubIssue, GitHubPullRequest } from '../../core/index.js';
import { logger, runCommand } from '../../core/index.js';
import {
  getIssues,
  updateIssueLabels,
  getPullRequests,
  updatePullRequestLabels,
  addIssueComment,
  addPullRequestComment,
  getViewerLogin,
} from '../../github/index.js';

/**
 * @what 単一のIssueについて、プレフィックスラベルが無い場合に自動トリアージを行い、コメントを投稿します。
 * @why タスクの新規起票からワークフローの乗せ換えまでを完全に自動化するため。
 */
async function triageSingleIssue(
  repo: string,
  item: GitHubIssue,
  prs: GitHubPullRequest[],
): Promise<void> {
  const labels = item.labels;
  const hasAgentLabel = labels.some((l) => l.startsWith('agent:'));
  if (hasAgentLabel) {
    return;
  }

  const hasActivePR = prs.some((pr) => {
    const issueRefRegex = new RegExp(`\\b#${item.number}\\b`);
    const branchNameRef = `issue-${item.number}`;
    return (
      issueRefRegex.test(pr.title) ||
      issueRefRegex.test(pr.body ?? '') ||
      pr.branch.includes(branchNameRef)
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
        await this.handleHumanReviews(repo);
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
    const runningIssues = await getIssues(repo, { label: 'agent:running' });
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
          [
            'agent:running',
            'agent:spec',
            'agent:dev',
            'agent:review-general',
            'agent:review-semantic',
            'agent:qa',
          ],
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
    const runningPRs = await getPullRequests(repo, { label: 'agent:running' });
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
          [
            'agent:running',
            'agent:spec',
            'agent:dev',
            'agent:review-general',
            'agent:review-semantic',
            'agent:qa',
          ],
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
      const issues = await getIssues(repo, { state: 'open' });
      let prs: GitHubPullRequest[] = [];
      try {
        prs = await getPullRequests(repo, { state: 'open' });
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

  /**
   * @what レビュー・QAフェーズにあるPRにおいて、人間からの CHANGES_REQUESTED が提出されているかを検知し、自動で agent:dev に差し戻します。
   * @why 人間のレビュー却下を無視してBotが勝手に処理を進めるのを防ぎ、自動で修正を依頼するため。
   */
  private async handleHumanReviews(repo: string): Promise<void> {
    logger.debug(`Checking human reviews for ${repo}...`, 'supervisor');
    try {
      const openPRs = await getPullRequests(repo, { state: 'open' });
      // レビューまたはQAのラベルがついているPRを対象にする
      const reviewLabels = ['agent:review-general', 'agent:review-semantic', 'agent:qa'];
      const targetPRs = openPRs.filter(
        (pr) =>
          pr.labels.some((l) => reviewLabels.includes(l)) && !pr.labels.includes('agent:running'),
      );

      if (targetPRs.length === 0) {
        return;
      }

      // Botのログインユーザー名を取得
      const botUser = await getViewerLogin();

      for (const pr of targetPRs) {
        const hasRejected = await this.checkHumanChangesRequested(repo, pr.number, botUser);
        if (hasRejected) {
          logger.warn(
            `PR #${pr.number} in ${repo} has pending human CHANGES_REQUESTED review. Returning to agent:dev.`,
            'supervisor',
          );

          // 現在ついているレビュー系のラベルを特定
          const currentReviewLabels = pr.labels.filter((l) => reviewLabels.includes(l));

          // ラベルを agent:dev に変更し、古いレビューラベルを削除
          await updatePullRequestLabels(repo, pr.number, ['agent:dev'], currentReviewLabels);

          const commentBody = `🤖 **Supervisor**: 人間によるレビュー却下（CHANGES_REQUESTED）が検知されました。修正を行うため、状態を開発フェーズ (\`agent:dev\`) に差し戻します。指摘コメントを確認し対応してください。`;
          try {
            await addPullRequestComment(repo, pr.number, commentBody);
          } catch (commentError) {
            logger.error(
              `Failed to post review redirect comment on PR #${pr.number}`,
              'supervisor',
              commentError,
            );
          }
        }
      }
    } catch (error) {
      logger.error(`Failed to handle human reviews in ${repo}`, 'supervisor', error);
    }
  }

  /**
   * @what 最新コミットのコミット日時より後に、Bot以外のユーザーによる CHANGES_REQUESTED レビューがあるかを判定します。
   * @why レビューが却下された場合に自動的に検知し、開発フェーズ（agent:dev）へ戻す判断を下すため。
   */
  private async checkHumanChangesRequested(
    repo: string,
    prNumber: number,
    botUser: string,
  ): Promise<boolean> {
    try {
      const result = await runCommand({
        cmd: 'gh',
        args: ['pr', 'view', String(prNumber), '--repo', repo, '--json', 'reviews,commits'],
        cwd: process.cwd(),
      });
      if (result.code !== 0) {
        logger.error(
          `Failed to get PR #${prNumber} details for supervisor: ${result.stderr}`,
          'supervisor',
        );
        return false;
      }
      const details = JSON.parse(result.stdout) as {
        commits: { committedDate: string; oid: string }[];
        reviews: { author: { login: string }; state: string; submittedAt: string }[];
      };

      if (details.commits.length === 0) {
        return false;
      }

      // 最新コミットのコミット日時
      const lastCommit = details.commits[details.commits.length - 1];
      const lastCommitDate = new Date(lastCommit.committedDate).getTime();

      // Bot以外のユーザーによる CHANGES_REQUESTED レビューを探す
      const humanReviews = details.reviews.filter(
        (r) => r.author.login !== botUser && r.state === 'CHANGES_REQUESTED',
      );

      for (const review of humanReviews) {
        const reviewDate = new Date(review.submittedAt).getTime();
        // 最新コミット日時以降に提出された CHANGES_REQUESTED があるか
        if (reviewDate >= lastCommitDate) {
          return true;
        }
      }
    } catch (error) {
      logger.error(`Error in checkHumanChangesRequested for PR #${prNumber}`, 'supervisor', error);
    }
    return false;
  }
}

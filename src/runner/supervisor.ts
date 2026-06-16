import type { AppConfig } from '../core/index.js';
import { logger, runCommand } from '../core/index.js';
import {
  getIssuesWithLabel,
  updateIssueLabels,
  getPullRequestsWithLabel,
  updatePullRequestLabels,
  getIssueComments,
  getViewerLogin,
} from './github-client.js';

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
        // 1. Recover stuck Issue locks
        await this.recoverStuckIssues(repo);

        // 2. Recover stuck PR locks
        await this.recoverStuckPRs(repo);

        // 3. Auto-label open issues that have no agent:* labels
        await this.triageUnlabeledIssues(repo);

        // 4. Recover waiting issues with forgotten agent:wait labels
        await this.recoverWaitingIssues(repo);
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

        // Remove lock and transition to triage
        await updateIssueLabels(
          repo,
          issue.number,
          ['agent:triage'],
          ['agent:running', 'agent:spec', 'agent:dev', 'agent:review', 'agent:qa'],
        );

        // Comment on the issue
        const commentBody = `⚠️ **Supervisor Alert**: このタスクの実行が15分以上停止していたため、自動実行ロックを解除して状態を \`agent:triage\` (人間による調査) に移行しました。実行中にCLIがフリーズしたか、エラーが発生した可能性があります。`;
        try {
          const result = await runCommand({
            cmd: 'gh',
            args: ['issue', 'comment', String(issue.number), '--repo', repo, '--body', commentBody],
            cwd: process.cwd(),
          });
          if (result.code !== 0) {
            throw new Error(result.stderr);
          }
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

        // Remove lock and transition to triage
        await updatePullRequestLabels(
          repo,
          pr.number,
          ['agent:triage'],
          ['agent:running', 'agent:spec', 'agent:dev', 'agent:review', 'agent:qa'],
        );

        // Comment on the PR
        const commentBody = `⚠️ **Supervisor Alert**: このプルリクエストのレビューまたはテスト実行が15分以上停止していたため、自動実行ロックを解除して状態を \`agent:triage\` (人間による調査) に移行しました。`;
        try {
          const result = await runCommand({
            cmd: 'gh',
            args: ['pr', 'comment', String(pr.number), '--repo', repo, '--body', commentBody],
            cwd: process.cwd(),
          });
          if (result.code !== 0) {
            throw new Error(result.stderr);
          }
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
    try {
      // Fetch open issues from the last 100 entries
      const result = await runCommand({
        cmd: 'gh',
        args: ['issue', 'list', '--repo', repo, '--limit', '100', '--json', 'number,title,labels'],
        cwd: process.cwd(),
      });
      if (result.code !== 0) {
        throw new Error(result.stderr);
      }
      const issues = JSON.parse(result.stdout) as RawIssueSummary[];

      // Fetch open pull requests to check for linked issues
      let prs: RawPRSummary[] = [];
      try {
        const prResult = await runCommand({
          cmd: 'gh',
          args: [
            'pr',
            'list',
            '--repo',
            repo,
            '--limit',
            '100',
            '--json',
            'number,title,body,headRefName',
          ],
          cwd: process.cwd(),
        });
        if (prResult.code === 0) {
          prs = JSON.parse(prResult.stdout) as RawPRSummary[];
        } else {
          throw new Error(prResult.stderr);
        }
      } catch (prError) {
        logger.error(`Failed to fetch pull requests in ${repo}`, 'supervisor', prError);
      }

      for (const item of issues) {
        const labels = item.labels.map((l) => l.name);
        const hasAgentLabel = labels.some((l) => l.startsWith('agent:'));

        if (!hasAgentLabel) {
          // Check if there is an active PR referencing this issue
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
            continue;
          }

          logger.info(
            `Unlabeled Issue #${item.number} found. Assigning agent:spec...`,
            'supervisor',
          );
          await updateIssueLabels(repo, item.number, ['agent:spec'], []);

          const commentBody = `🤖 **Supervisor**: 新しい課題が検知されました。自動開発ワークフローを開始するため、仕様定義エージェント (\`agent:spec\`) を自動で割り当てます。壁打ち対話の開始をお待ちください。`;
          const commentResult = await runCommand({
            cmd: 'gh',
            args: ['issue', 'comment', String(item.number), '--repo', repo, '--body', commentBody],
            cwd: process.cwd(),
          });
          if (commentResult.code !== 0) {
            throw new Error(commentResult.stderr);
          }
        }
      }
    } catch (error) {
      logger.error(`Failed to triage unlabeled issues in ${repo}`, 'supervisor', error);
    }
  }

  /**
   * @what 'agent:wait' が付与されたまま放置されているIssueを検知し、自動的に解除（再開）します。
   * @why ユーザーがコメントを追加せずに、Issueの本文編集やリアクション等でアクションを取った場合、タスクがスタックしてしまうため、
   *      更新日時（updatedAt）の差分をチェックして、人のアクティビティがあれば自動救済します。
   */
  private async recoverWaitingIssues(repo: string): Promise<void> {
    try {
      const waitingIssues = await getIssuesWithLabel(repo, 'agent:wait');
      if (waitingIssues.length === 0) {
        return;
      }

      const currentBotUser = await getViewerLogin();

      for (const issue of waitingIssues) {
        const comments = await getIssueComments(repo, issue.number);
        if (comments.length > 0) {
          const latestComment = comments[comments.length - 1];

          // If the latest comment is from the bot itself, but the issue's updatedAt is newer
          // than the comment's createdAt, it means someone updated the description/labels/etc.
          if (latestComment.user === currentBotUser) {
            const updatedAt = new Date(issue.updatedAt).getTime();
            const commentCreatedAt = new Date(latestComment.createdAt).getTime();

            // 15 minutes threshold to allow users to finish consecutive operations and recover forgotten label
            if (updatedAt - commentCreatedAt > 15 * 60 * 1000) {
              logger.info(
                `User activity (edit/label) detected on Issue #${issue.number} with forgotten wait label. Auto-removing 'agent:wait'.`,
                'supervisor',
              );
              await updateIssueLabels(repo, issue.number, [], ['agent:wait']);

              const commentBody = `🤖 **Supervisor**: ユーザーのアクティビティ検出から15分が経過したため、\`agent:wait\` ラベルを自動解除して処理を再開します。`;
              const commentResult = await runCommand({
                cmd: 'gh',
                args: [
                  'issue',
                  'comment',
                  String(issue.number),
                  '--repo',
                  repo,
                  '--body',
                  commentBody,
                ],
                cwd: process.cwd(),
              });
              if (commentResult.code !== 0) {
                throw new Error(commentResult.stderr);
              }
            }
          }
        }
      }
    } catch (error) {
      logger.error(`Failed to recover waiting issues in ${repo}`, 'supervisor', error);
    }
  }
}

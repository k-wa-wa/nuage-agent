import { AppConfig, logger } from '@nuage-agent/core';
import { 
  getIssuesWithLabel, 
  updateIssueLabels, 
  getPullRequestsWithLabel, 
  updatePullRequestLabels 
} from './github-client.js';
import { exec } from 'child_process';

function execCommand(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

export class PipelineSupervisor {
  private config: AppConfig;
  private timeoutLimitMs = 15 * 60 * 1000; // 15 minutes

  constructor(config: AppConfig) {
    this.config = config;
  }

  /**
   * Run the supervisor checks to clean up and triage issues/PRs.
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
      }
    } catch (error) {
      logger.error('Error during Supervisor checks', 'supervisor', error);
    }
    logger.info('Supervisor checks completed.', 'supervisor');
  }

  private async recoverStuckIssues(repo: string): Promise<void> {
    const runningIssues = await getIssuesWithLabel(repo, 'agent:running');
    const now = new Date().getTime();

    for (const issue of runningIssues) {
      const updatedAt = new Date(issue.updatedAt).getTime();
      const timeElapsed = now - updatedAt;

      if (timeElapsed > this.timeoutLimitMs) {
        logger.warn(`Stuck lock detected on Issue #${issue.number} in ${repo} (Last updated: ${issue.updatedAt})`, 'supervisor');
        
        // Remove lock and transition to triage
        await updateIssueLabels(
          repo, 
          issue.number, 
          ['agent:triage'], 
          ['agent:running', 'agent:spec', 'agent:dev', 'agent:review', 'agent:qa']
        );

        // Comment on the issue
        const commentBody = `⚠️ **Supervisor Alert**: このタスクの実行が15分以上停止していたため、自動実行ロックを解除して状態を \`agent:triage\` (人間による調査) に移行しました。実行中にCLIがフリーズしたか、エラーが発生した可能性があります。`;
        try {
          await execCommand(`gh issue comment ${issue.number} --repo "${repo}" --body "${commentBody}"`);
          logger.success(`Posted timeout alert comment on Issue #${issue.number}`, 'supervisor');
        } catch (error) {
          logger.error(`Failed to post comment on Issue #${issue.number}`, 'supervisor', error);
        }
      }
    }
  }

  private async recoverStuckPRs(repo: string): Promise<void> {
    const runningPRs = await getPullRequestsWithLabel(repo, 'agent:running');
    const now = new Date().getTime();

    for (const pr of runningPRs) {
      const updatedAt = new Date(pr.updatedAt).getTime();
      const timeElapsed = now - updatedAt;

      if (timeElapsed > this.timeoutLimitMs) {
        logger.warn(`Stuck lock detected on PR #${pr.number} in ${repo} (Last updated: ${pr.updatedAt})`, 'supervisor');
        
        // Remove lock and transition to triage
        await updatePullRequestLabels(
          repo, 
          pr.number, 
          ['agent:triage'], 
          ['agent:running', 'agent:spec', 'agent:dev', 'agent:review', 'agent:qa']
        );

        // Comment on the PR
        const commentBody = `⚠️ **Supervisor Alert**: このプルリクエストのレビューまたはテスト実行が15分以上停止していたため、自動実行ロックを解除して状態を \`agent:triage\` (人間による調査) に移行しました。`;
        try {
          await execCommand(`gh pr comment ${pr.number} --repo "${repo}" --body "${commentBody}"`);
          logger.success(`Posted timeout alert comment on PR #${pr.number}`, 'supervisor');
        } catch (error) {
          logger.error(`Failed to post comment on PR #${pr.number}`, 'supervisor', error);
        }
      }
    }
  }

  private async triageUnlabeledIssues(repo: string): Promise<void> {
    try {
      // Fetch open issues from the last 100 entries
      const cmd = `gh issue list --repo "${repo}" --limit 100 --json number,title,labels`;
      const output = await execCommand(cmd);
      const issues = JSON.parse(output) as any[];

      for (const item of issues) {
        const labels = item.labels.map((l: any) => l.name) as string[];
        const hasAgentLabel = labels.some(l => l.startsWith('agent:'));

        if (!hasAgentLabel) {
          logger.info(`Unlabeled Issue #${item.number} found. Assigning agent:spec...`, 'supervisor');
          await updateIssueLabels(repo, item.number, ['agent:spec'], []);
          
          const commentBody = `🤖 **Orchestrator**: 新しい課題が検知されました。自動開発ワークフローを開始するため、仕様定義エージェント (\`agent:spec\`) を自動で割り当てます。壁打ち対話の開始をお待ちください。`;
          await execCommand(`gh issue comment ${item.number} --repo "${repo}" --body "${commentBody}"`);
        }
      }
    } catch (error) {
      logger.error(`Failed to triage unlabeled issues in ${repo}`, 'supervisor', error);
    }
  }
}

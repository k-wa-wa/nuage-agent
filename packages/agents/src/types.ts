import { GitHubIssue, GitHubPullRequest } from '@nuage-agent/core';

export interface AgentContext {
  repoName: string;
  repoMapMd: string;
  issue?: GitHubIssue;
  pr?: GitHubPullRequest;
  commentsMarkdown?: string;
}

export interface Agent {
  readonly id: string; // 例: 'spec', 'dev', 'review-general', 'review-semantic', 'qa'
  readonly targetType: 'issue' | 'pr';
  readonly label: string; // 例: 'agent:spec', 'agent:dev', 'agent:review', 'agent:qa'
  readonly commandType: 'claude' | 'gemini';

  /**
   * エージェント実行のためのシステム・指示プロンプトを組み立てます。
   */
  buildPrompt(context: AgentContext): string;
}

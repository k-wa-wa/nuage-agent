import type { GitHubIssue, GitHubPullRequest } from '@nuage-agent/core';

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
   * @what エージェント実行のためのシステム・指示プロンプトをコンテキスト情報から組み立てます。
   * @why 各エージェント（spec, dev, review等）が固有のロールプレイングプロンプトを持てるよう、
   *      コンテキスト（Issue/PR/リポジトリ情報）を注入してLLMへの指示文を生成するため。
   */
  buildPrompt(context: AgentContext): string;
}

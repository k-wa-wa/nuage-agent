export type AgentType = 'spec' | 'dev' | 'review' | 'qa' | 'triage';

export interface AppConfig {
  repositories: string[]; // YAMLから読み込まれるリポジトリリスト
  repoMapDir: string; // repo-mapディレクトリへのパス
  pollingIntervalSeconds: number;
  claudeCommand: string;
  claudeFlags: string[];
  geminiCommand: string;
  geminiFlags: string[];
  workspacesDir: string;
  qaAutoMerge: boolean;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  user: string;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubComment {
  id: number;
  body: string;
  user: string;
  createdAt: string;
}

export interface GitHubPullRequest {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: string[];
  branch: string;
  baseBranch: string;
  merged: boolean;
  createdAt: string;
  updatedAt: string;
}

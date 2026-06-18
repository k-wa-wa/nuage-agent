import type { GitHubPullRequest } from '../core/index.js';
import { logger, runCommand } from '../core/index.js';
import type { RawGHPR } from './client.js';
import { updateLabels, addComment } from './common.js';

/**
 * @what 指定したリポジトリから、特定のPull Request番号の最新情報を取得します。
 * @why 最新のラベル状態をGitHub APIから直接取得し、他プロセスによる二重実行（競合）を防ぐ厳密なロックチェックを行うため。
 */
export async function getPullRequest(
  repo: string,
  prNumber: number,
): Promise<GitHubPullRequest | null> {
  try {
    const result = await runCommand({
      cmd: 'gh',
      args: [
        'pr',
        'view',
        String(prNumber),
        '--repo',
        repo,
        '--json',
        'number,title,body,state,labels,headRefName,baseRefName,createdAt,updatedAt',
      ],
      cwd: process.cwd(),
    });
    if (result.code !== 0) {
      logger.error(
        `Failed to view PR #${prNumber} from ${repo}: ${result.stderr}`,
        'github-client',
      );
      return null;
    }
    const item = JSON.parse(result.stdout) as RawGHPR;
    return {
      number: item.number,
      title: item.title,
      body: item.body,
      state: item.state.toLowerCase() as 'open' | 'closed',
      labels: item.labels.map((l) => l.name),
      branch: item.headRefName,
      baseBranch: item.baseRefName,
      merged: item.state.toLowerCase() === 'merged',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  } catch (error) {
    logger.error(`Failed to get PR #${prNumber} from ${repo}`, 'github-client', error);
    return null;
  }
}

export interface GetPullRequestsOptions {
  state?: 'open' | 'closed' | 'merged' | 'all';
  label?: string;
  limit?: number;
}

/**
 * @what 指定したリポジトリから、条件に応じたGitHub Pull Requestの一覧を取得します。
 * @why 重複するlist系関数を統合し、コードの保守性を高めるため。
 */
export async function getPullRequests(
  repo: string,
  options: GetPullRequestsOptions = {},
): Promise<GitHubPullRequest[]> {
  try {
    const state = options.state ?? 'open';
    const limit = options.limit ?? 100;

    const args = ['pr', 'list', '--repo', repo, '--state', state, '--limit', String(limit)];
    if (options.label) {
      args.push('--label', options.label);
    }
    args.push(
      '--json',
      'number,title,body,state,labels,headRefName,baseRefName,createdAt,updatedAt',
    );

    const result = await runCommand({
      cmd: 'gh',
      args,
      cwd: process.cwd(),
    });
    if (result.code !== 0) {
      throw new Error(result.stderr);
    }
    const parsed = JSON.parse(result.stdout) as RawGHPR[];
    return parsed.map((item) => ({
      number: item.number,
      title: item.title,
      body: item.body,
      state: item.state.toLowerCase() as 'open' | 'closed',
      labels: item.labels.map((l) => l.name),
      branch: item.headRefName,
      baseBranch: item.baseRefName,
      merged: item.state.toLowerCase() === 'merged',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
  } catch (error) {
    logger.error(`Failed to get pull requests from ${repo}`, 'github-client', error);
    return [];
  }
}

/**
 * @what 指定したPRにラベルを追加・削除します。
 * @why 共通の updateLabels 関数を呼び出し、コードの重複を排除するため。
 */
export async function updatePullRequestLabels(
  repo: string,
  prNumber: number,
  addLabels: string[],
  removeLabels: string[],
): Promise<void> {
  return updateLabels(repo, prNumber, addLabels, removeLabels);
}

/**
 * @what 指定したPRに新しくコメントを追加投稿します。
 * @why 共通の addComment 関数を呼び出し、コードの重複を排除するため。
 */
export async function addPullRequestComment(
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  return addComment(repo, prNumber, body);
}

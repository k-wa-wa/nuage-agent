import type { GitHubIssue, GitHubComment } from '../core/index.js';
import { logger, runCommand } from '../core/index.js';
import type { RawGHIssue, RawGHCommentsResponse } from './client.js';
import { updateLabels, addComment } from './common.js';

export interface GetIssuesOptions {
  state?: 'open' | 'closed' | 'all';
  label?: string;
  limit?: number;
}

/**
 * @what 指定したリポジトリから、条件に応じたGitHub Issueの一覧を取得します。
 * @why 重複するlist系関数を統合し、コードの保守性を高めるため。
 */
export async function getIssues(
  repo: string,
  options: GetIssuesOptions = {},
): Promise<GitHubIssue[]> {
  try {
    const state = options.state ?? 'open';
    const limit = options.limit ?? 100;

    const args = ['issue', 'list', '--repo', repo, '--state', state, '--limit', String(limit)];
    if (options.label) {
      args.push('--label', options.label);
    }
    args.push('--json', 'number,title,body,state,labels,createdAt,updatedAt');

    const result = await runCommand({
      cmd: 'gh',
      args,
      cwd: process.cwd(),
    });
    if (result.code !== 0) {
      throw new Error(result.stderr);
    }
    const parsed = JSON.parse(result.stdout) as RawGHIssue[];
    return parsed.map((item) => ({
      number: item.number,
      title: item.title,
      body: item.body,
      state: item.state.toLowerCase() as 'open' | 'closed',
      labels: item.labels.map((l) => l.name),
      user: '',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
  } catch (error) {
    logger.error(`Failed to get issues from ${repo}`, 'github-client', error);
    return [];
  }
}

/**
 * @what 指定したリポジトリから、特定のIssue番号の最新情報を取得します。
 * @why 最新のラベル状態をGitHub APIから直接取得し、他プロセスによる二重実行（競合）を防ぐ厳密なロックチェックを行うため。
 */
export async function getIssue(repo: string, issueNumber: number): Promise<GitHubIssue | null> {
  try {
    const result = await runCommand({
      cmd: 'gh',
      args: [
        'issue',
        'view',
        String(issueNumber),
        '--repo',
        repo,
        '--json',
        'number,title,body,state,labels,createdAt,updatedAt',
      ],
      cwd: process.cwd(),
    });
    if (result.code !== 0) {
      logger.error(
        `Failed to view issue #${issueNumber} from ${repo}: ${result.stderr}`,
        'github-client',
      );
      return null;
    }
    const item = JSON.parse(result.stdout) as RawGHIssue;
    return {
      number: item.number,
      title: item.title,
      body: item.body,
      state: item.state.toLowerCase() as 'open' | 'closed',
      labels: item.labels.map((l) => l.name),
      user: '',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  } catch (error) {
    logger.error(`Failed to get issue #${issueNumber} from ${repo}`, 'github-client', error);
    return null;
  }
}

/**
 * @what 指定したIssueのコメント一覧を取得し、内部型（GitHubComment[]）にマッピングして返します。
 * @why コメント履歴からBotが最後に発言した時刻やユーザー名を判定し、agent:wait解除を行うため。
 */
export async function getIssueComments(
  repo: string,
  issueNumber: number,
): Promise<GitHubComment[]> {
  try {
    const result = await runCommand({
      cmd: 'gh',
      args: ['issue', 'view', String(issueNumber), '--repo', repo, '--json', 'comments'],
      cwd: process.cwd(),
    });
    if (result.code !== 0) {
      throw new Error(result.stderr);
    }
    const parsed = JSON.parse(result.stdout) as RawGHCommentsResponse;
    return parsed.comments.map((item) => ({
      id: item.id,
      body: item.body,
      user: item.author.login,
      createdAt: item.createdAt,
    }));
  } catch (error) {
    logger.error(
      `Failed to get comments for issue #${issueNumber} from ${repo}`,
      'github-client',
      error,
    );
    return [];
  }
}

/**
 * @what 指定したIssueにラベルを追加・削除します。
 * @why 共通の updateLabels 関数を呼び出し、コードの重複を排除するため。
 */
export async function updateIssueLabels(
  repo: string,
  issueNumber: number,
  addLabels: string[],
  removeLabels: string[],
): Promise<void> {
  return updateLabels(repo, issueNumber, addLabels, removeLabels);
}

/**
 * @what 指定したIssueに新しくコメントを追加投稿します。
 * @why 共通の addComment 関数を呼び出し、コードの重複を排除するため。
 */
export async function addIssueComment(
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  return addComment(repo, issueNumber, body);
}

import type { GitHubIssue, GitHubComment } from '../core/index.js';
import { logger, runCommand } from '../core/index.js';
import type { RawGHIssue, RawGHCommentsResponse, RawIssueSummary } from './client.js';

/**
 * @what 指定したリポジトリから、特定のラベルを持つ全GitHub Issueを取得します。
 * @why エージェントパイプライン用のラベルが付いたIssueを一括取得し、巡回処理の起点とするため。
 */
export async function getIssuesWithLabel(repo: string, label: string): Promise<GitHubIssue[]> {
  try {
    const result = await runCommand({
      cmd: 'gh',
      args: [
        'issue',
        'list',
        '--repo',
        repo,
        '--label',
        label,
        '--json',
        'number,title,body,state,labels,createdAt,updatedAt',
      ],
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
    logger.error(`Failed to get issues with label ${label} from ${repo}`, 'github-client', error);
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
 * @why エージェントパイプラインの状態遷移やwaitラベルの付け外しを gh CLI 経由で行うため。
 */
export async function updateIssueLabels(
  repo: string,
  issueNumber: number,
  addLabels: string[],
  removeLabels: string[],
): Promise<void> {
  try {
    const args = ['issue', 'edit', String(issueNumber), '--repo', repo];
    for (const label of addLabels) {
      args.push('--add-label', label);
    }
    for (const label of removeLabels) {
      args.push('--remove-label', label);
    }
    const result = await runCommand({ cmd: 'gh', args, cwd: process.cwd() });
    if (result.code !== 0) {
      throw new Error(result.stderr);
    }
    logger.success(
      `Updated labels for issue #${issueNumber} (Added: [${addLabels.join(',')}], Removed: [${removeLabels.join(',')}])`,
      'github-client',
    );
  } catch (error) {
    logger.error(`Failed to update labels for issue #${issueNumber}`, 'github-client', error);
  }
}

/**
 * @what 指定したリポジトリから、オープン状態のIssueを最大100件一括で取得します。
 * @why クローラーの定期巡回時のGitHub APIコール数を削減するため。
 */
export async function getAllOpenIssues(repo: string): Promise<GitHubIssue[]> {
  try {
    const result = await runCommand({
      cmd: 'gh',
      args: [
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,title,body,state,labels,createdAt,updatedAt',
      ],
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
    logger.error(`Failed to get all open issues from ${repo}`, 'github-client', error);
    return [];
  }
}

/**
 * @what GitHub CLI を用いて対象リポジトリの直近オープンIssue一覧を取得します。
 * @why 未割り当てIssueを検出するための最新情報を取得するため。
 */
export async function getRawIssues(repo: string): Promise<RawIssueSummary[]> {
  const result = await runCommand({
    cmd: 'gh',
    args: ['issue', 'list', '--repo', repo, '--limit', '100', '--json', 'number,title,labels'],
    cwd: process.cwd(),
  });
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
  return JSON.parse(result.stdout) as RawIssueSummary[];
}

/**
 * @what 指定したIssueに新しくコメントを追加投稿します。
 * @why エージェント進行状況やエラーアラート、自動開始コメントをユーザーに通知するため。
 */
export async function addIssueComment(
  repo: string,
  issueNumber: number,
  body: string,
): Promise<void> {
  const result = await runCommand({
    cmd: 'gh',
    args: ['issue', 'comment', String(issueNumber), '--repo', repo, '--body', body],
    cwd: process.cwd(),
  });
  if (result.code !== 0) {
    throw new Error(result.stderr);
  }
}

/**
 * @what 指定したリポジトリから、すべての状態（open/closed）の最近のIssueのタイトル、状態、作成日時を取得します。
 * @why QA改善Issueの定期起票チェックにおける重複確認や経過時間検証を行うため。
 */
export async function getRecentIssues(
  repo: string,
): Promise<{ title: string; state: string; createdAt: string }[]> {
  try {
    const result = await runCommand({
      cmd: 'gh',
      args: [
        'issue',
        'list',
        '--repo',
        repo,
        '--state',
        'all',
        '--limit',
        '100',
        '--json',
        'title,state,createdAt',
      ],
      cwd: process.cwd(),
    });
    if (result.code !== 0) {
      throw new Error(result.stderr);
    }
    return JSON.parse(result.stdout) as { title: string; state: string; createdAt: string }[];
  } catch (error) {
    logger.error(`Failed to get recent issues from ${repo}`, 'github-client', error);
    return [];
  }
}

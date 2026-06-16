import type { GitHubPullRequest } from '../core/index.js';
import { logger, runCommand } from '../core/index.js';
import type { RawGHPR, RawPRSummary } from './client.js';
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

/**
 * @what 指定したリポジトリから、特定のラベルを持つ全GitHub Pull Requestを取得します。
 * @why PRパイプラインの巡回処理で、ラベル付きPRを一括取得するため。
 */
export async function getPullRequestsWithLabel(
  repo: string,
  label: string,
): Promise<GitHubPullRequest[]> {
  try {
    const result = await runCommand({
      cmd: 'gh',
      args: [
        'pr',
        'list',
        '--repo',
        repo,
        '--label',
        label,
        '--json',
        'number,title,body,state,labels,headRefName,baseRefName,createdAt,updatedAt',
      ],
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
    logger.error(
      `Failed to get pull requests with label ${label} from ${repo}`,
      'github-client',
      error,
    );
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
 * @what 指定したリポジトリから、オープン状態のPull Requestを最大100件一括で取得します。
 * @why クローラーの定期巡回時のGitHub APIコール数を削減するため。
 */
export async function getAllOpenPRs(repo: string): Promise<GitHubPullRequest[]> {
  try {
    const result = await runCommand({
      cmd: 'gh',
      args: [
        'pr',
        'list',
        '--repo',
        repo,
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,title,body,state,labels,headRefName,baseRefName,createdAt,updatedAt',
      ],
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
    logger.error(`Failed to get all open PRs from ${repo}`, 'github-client', error);
    return [];
  }
}

/**
 * @what GitHub CLI を用いて対象リポジトリの直近オープンPR一覧を取得します。
 * @why 未割り当てIssueがPRに紐づいているかどうかの検証に用いるため。
 */
export async function getRawPRs(repo: string): Promise<RawPRSummary[]> {
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
    return JSON.parse(prResult.stdout) as RawPRSummary[];
  }
  throw new Error(prResult.stderr);
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

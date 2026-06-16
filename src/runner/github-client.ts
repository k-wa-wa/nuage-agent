import type { GitHubIssue, GitHubComment, GitHubPullRequest } from '../core/index.js';
import { logger, runCommand } from '../core/index.js';

// Raw shapes returned by the GitHub CLI (gh) JSON output.
// These are internal to this module; consumers use the GitHubIssue/Comment/PR types.
interface RawGHIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string }[];
  createdAt: string;
  updatedAt: string;
}

interface RawGHComment {
  id: number;
  body: string;
  author: { login: string };
  createdAt: string;
}

interface RawGHCommentsResponse {
  comments: RawGHComment[];
}

interface RawGHPR {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string }[];
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * @what 指定したリポジトリから、特定のラベルを持つ全GitHub Issueを取得します。
 * @why エージェントパイプライン用のラベル（agent:spec, agent:dev等）が付いたIssueを一括取得し、巡回処理の起点とするため。
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
      user: '', // gh issue list doesn't return user by default, not needed for pipeline check
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
 * @why 処理直前に最新のラベル状態をGitHub APIから直接取得し、他プロセスによる二重実行（競合）を防ぐ厳密なロックチェックを行うため。
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
 * @what 指定したリポジトリから、特定のPull Request番号の最新情報を取得します。
 * @why 処理直前に最新のラベル状態をGitHub APIから直接取得し、他プロセスによる二重実行（競合）を防ぐ厳密なロックチェックを行うため。
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
 * @what 指定したIssueのコメント一覧を取得し、内部型（GitHubComment[]）にマッピングして返します。
 * @why コメント履歴からBotが最後に発言した時刻やユーザー名を判定し、agent:waitスロットリング解除を行うため。
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
    const commentsList = parsed.comments;
    return commentsList.map((item) => ({
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
 * @why エージェントパイプラインの状態遷移（spec→dev→review→qa）やwaitラベルの付け外しを gh CLI 経由で行うため。
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
    const result = await runCommand({
      cmd: 'gh',
      args,
      cwd: process.cwd(),
    });
    if (result.code !== 0) {
      throw new Error(result.stderr);
    }
    logger.success(
      `Updated labels for issue #${issueNumber} in ${repo} (Added: [${addLabels.join(',')}], Removed: [${removeLabels.join(',')}])`,
      'github-client',
    );
  } catch (error) {
    logger.error(
      `Failed to update labels for issue #${issueNumber} in ${repo}`,
      'github-client',
      error,
    );
  }
}

/**
 * @what 指定したリポジトリから、特定のラベルを持つ全GitHub Pull Requestを取得します。
 * @why PRパイプライン（agent:review, agent:qa等）の巡回処理で、ラベル付きPRを一括取得するため。
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
 * @why PRパイプラインの状態遷移（review→dev, review→qa等）や実行ロック制御をgh CLI経由で行うため。
 */
export async function updatePullRequestLabels(
  repo: string,
  prNumber: number,
  addLabels: string[],
  removeLabels: string[],
): Promise<void> {
  try {
    const args = ['issue', 'edit', String(prNumber), '--repo', repo];
    for (const label of addLabels) {
      args.push('--add-label', label);
    }
    for (const label of removeLabels) {
      args.push('--remove-label', label);
    }
    const result = await runCommand({
      cmd: 'gh',
      args,
      cwd: process.cwd(),
    });
    if (result.code !== 0) {
      throw new Error(result.stderr);
    }
    logger.success(
      `Updated labels for PR #${prNumber} in ${repo} (Added: [${addLabels.join(',')}], Removed: [${removeLabels.join(',')}])`,
      'github-client',
    );
  } catch (error) {
    logger.error(`Failed to update labels for PR #${prNumber} in ${repo}`, 'github-client', error);
  }
}

const PIPELINE_LABELS = [
  { name: 'agent:spec', color: 'fbca04', description: 'Specification phase' },
  { name: 'agent:dev', color: '1d76db', description: 'Development phase' },
  { name: 'agent:review', color: '0e8a16', description: 'Review phase' },
  { name: 'agent:qa', color: 'b60205', description: 'QA phase' },
  { name: 'agent:triage', color: 'd93f0b', description: 'Triage phase' },
  { name: 'agent:running', color: '5319e7', description: 'Currently running' },
  { name: 'agent:wait', color: '6f42c1', description: 'Waiting for user input/action' },
];

/**
 * @what パイプラインの各フェーズに用いる GitHub ラベルを一括作成・更新（冪等）します。
 * @why ランナーの起動前に確実に状態ラベルが存在することを保証し、手動で GitHub 上にラベルを作成する手間を省くため。
 *      権限エラーを防ぐためにランナー本体の起動処理からは切り離し、独立したCLIコマンドから実行するようにしました。
 */
export async function ensureLabelsExist(repo: string): Promise<void> {
  logger.info(
    `Checking and ensuring pipeline labels exist for repository: ${repo}`,
    'github-client',
  );
  for (const label of PIPELINE_LABELS) {
    try {
      const result = await runCommand({
        cmd: 'gh',
        args: [
          'label',
          'create',
          label.name,
          '--repo',
          repo,
          '--color',
          label.color,
          '--description',
          label.description,
          '--force',
        ],
        cwd: process.cwd(),
      });
      if (result.code !== 0) {
        throw new Error(result.stderr);
      }
    } catch (error) {
      logger.error(
        `Failed to ensure label "${label.name}" exists in ${repo}`,
        'github-client',
        error,
      );
    }
  }
}

/**
 * @what GitHub CLI (gh) の現在のアクティブなログインユーザー名を取得します。
 * @why 自身のBot発言とユーザーの発言を区別し、回答待ちスロットリング状態（agent:wait）を自動解除するために現在のBotのユーザー名を特定する必要があるため。
 */
export async function getViewerLogin(): Promise<string> {
  try {
    const result = await runCommand({
      cmd: 'gh',
      args: ['api', 'user', '--jq', '.login'],
      cwd: process.cwd(),
    });
    if (result.code !== 0) {
      throw new Error(result.stderr);
    }
    return result.stdout.trim();
  } catch (error) {
    logger.error('Failed to get current gh user login', 'github-client', error);
    return '';
  }
}

/**
 * @what 指定したリポジトリから、すべての状態（open/closed）の最近のIssueのタイトル、状態、作成日時を取得します。
 * @why QA改善Issueの定期起票チェックにおいて、すでに同じプレフィックスを持つIssueがオープンされているか、または前回の起票から指定時間（例: 10分、1日）が経過しているかを検証するため。
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

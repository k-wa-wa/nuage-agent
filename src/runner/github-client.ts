import { exec } from 'child_process';
import type { GitHubIssue, GitHubComment, GitHubPullRequest } from '../core/index.js';
import { logger } from '../core/index.js';

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
 * @what 指定したシェルコマンドを実行し、その標準出力を文字列として返す薄いラッパー関数です。
 * @why github-client 内の gh CLI 呼び出しを一箇所に集約することで、エラーハンドリングと非同期変換を統一するため。
 */
function execCommand(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        logger.error(`gh command error: ${stderr}`, 'github-client');
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

/**
 * @what 指定したリポジトリから、特定のラベルを持つ全GitHub Issueを取得します。
 * @why エージェントパイプライン用のラベル（agent:spec, agent:dev等）が付いたIssueを一括取得し、巡回処理の起点とするため。
 */
export async function getIssuesWithLabel(repo: string, label: string): Promise<GitHubIssue[]> {
  try {
    const cmd = `gh issue list --repo "${repo}" --label "${label}" --json number,title,body,state,labels,createdAt,updatedAt`;
    const output = await execCommand(cmd);
    const parsed = JSON.parse(output) as RawGHIssue[];
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
 * @what 指定したIssueのコメント一覧を取得し、内部型（GitHubComment[]）にマッピングして返します。
 * @why コメント履歴からBotが最後に発言した時刻やユーザー名を判定し、agent:waitスロットリング解除を行うため。
 */
export async function getIssueComments(
  repo: string,
  issueNumber: number,
): Promise<GitHubComment[]> {
  try {
    const cmd = `gh issue view ${issueNumber} --repo "${repo}" --json comments`;
    const output = await execCommand(cmd);
    const parsed = JSON.parse(output) as RawGHCommentsResponse;
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
    let cmd = `gh issue edit ${issueNumber} --repo "${repo}"`;
    if (addLabels.length > 0) {
      cmd += ' ' + addLabels.map((l) => `--add-label "${l}"`).join(' ');
    }
    if (removeLabels.length > 0) {
      cmd += ' ' + removeLabels.map((l) => `--remove-label "${l}"`).join(' ');
    }
    await execCommand(cmd);
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
    const cmd = `gh pr list --repo "${repo}" --label "${label}" --json number,title,body,state,labels,headRefName,baseRefName,createdAt,updatedAt`;
    const output = await execCommand(cmd);
    const parsed = JSON.parse(output) as RawGHPR[];
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
    let cmd = `gh pr edit ${prNumber} --repo "${repo}"`;
    if (addLabels.length > 0) {
      cmd += ' ' + addLabels.map((l) => `--add-label "${l}"`).join(' ');
    }
    if (removeLabels.length > 0) {
      cmd += ' ' + removeLabels.map((l) => `--remove-label "${l}"`).join(' ');
    }
    await execCommand(cmd);
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
      const cmd = `gh label create "${label.name}" --repo "${repo}" --color "${label.color}" --description "${label.description}" --force`;
      await execCommand(cmd);
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
    const output = await execCommand('gh api user --jq .login');
    return output.trim();
  } catch (error) {
    logger.error('Failed to get current gh user login', 'github-client', error);
    return '';
  }
}

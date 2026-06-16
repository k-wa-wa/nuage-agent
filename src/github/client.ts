import { runCommand, logger } from '../core/index.js';

export interface RawGHIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: { name: string }[];
  createdAt: string;
  updatedAt: string;
}

export interface RawGHComment {
  id: number;
  body: string;
  author: { login: string };
  createdAt: string;
}

export interface RawGHCommentsResponse {
  comments: RawGHComment[];
}

export interface RawGHPR {
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

export interface RawIssueSummary {
  number: number;
  title: string;
  labels: { name: string }[];
}

export interface RawPRSummary {
  number: number;
  title: string;
  body: string;
  headRefName: string;
}

/**
 * @what GitHub CLI (gh) の現在のアクティブなログインユーザー名を取得します。
 * @why 自身のBot発言とユーザーの発言を区別するため。
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

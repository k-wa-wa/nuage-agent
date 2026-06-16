import { runCommand, logger } from '../core/index.js';

/**
 * @what 指定したIssueまたはPRにラベルを追加・削除します。
 * @why プルリクエストもGitHub内部ではIssue扱いであり、gh issue edit コマンドで同様にラベル変更が可能なため、共通化して実装をシンプルにするため。
 */
export async function updateLabels(
  repo: string,
  number: number,
  addLabels: string[],
  removeLabels: string[],
): Promise<void> {
  try {
    const args = ['issue', 'edit', String(number), '--repo', repo];
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
      `Updated labels for #${number} (Added: [${addLabels.join(',')}], Removed: [${removeLabels.join(',')}])`,
      'github-client',
    );
  } catch (error) {
    logger.error(`Failed to update labels for #${number} in ${repo}`, 'github-client', error);
  }
}

/**
 * @what 指定したIssueまたはPRに新しくコメントを追加投稿します。
 * @why プルリクエストもGitHub内部ではIssue扱いであり、gh issue comment コマンドで同様にコメント投稿が可能なため、共通化して実装をシンプルにするため。
 */
export async function addComment(repo: string, number: number, body: string): Promise<void> {
  try {
    const result = await runCommand({
      cmd: 'gh',
      args: ['issue', 'comment', String(number), '--repo', repo, '--body', body],
      cwd: process.cwd(),
    });
    if (result.code !== 0) {
      throw new Error(result.stderr);
    }
  } catch (error) {
    logger.error(`Failed to add comment to #${number} in ${repo}`, 'github-client', error);
    throw error;
  }
}

import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { AppConfig } from '../core/index.js';
import { logger } from '../core/index.js';

/**
 * @what 対象リポジトリを `workspaces/` 配下にローカルクローンし、最新の `main` / `master` ブランチを取得して常に同期します。
 * @why 各エージェント（仕様・開発・QAなど）がローカルファイルシステム上で安全にファイルを編集・テスト実行・PR作成などを行えるよう、最新の開発作業環境を用意するため。
 */
export function ensureWorkspace(repo: string, config: AppConfig): string {
  // Repo is e.g. "k-wa-wa/workflow-sandbox" -> folder name is "workflow-sandbox"
  const repoFolder = repo.split('/').pop() ?? repo;
  const targetDir = path.resolve(config.workspacesDir, repoFolder);

  // Ensure parent workspaces dir exists
  if (!fs.existsSync(config.workspacesDir)) {
    fs.mkdirSync(config.workspacesDir, { recursive: true });
  }

  if (!fs.existsSync(targetDir)) {
    logger.info(`Cloning repository ${repo} to ${targetDir}...`, 'workspace');
    try {
      const result = spawnSync('gh', ['repo', 'clone', repo, targetDir], {
        stdio: 'inherit',
        shell: false,
      });
      if (result.status !== 0) {
        throw new Error(`gh repo clone failed with status ${result.status}`);
      }
      logger.success(`Repository ${repo} cloned successfully.`, 'workspace');
    } catch (error) {
      logger.error(`Failed to clone repository ${repo}`, 'workspace', error);
      throw error;
    }
  } else {
    logger.info(`Updating repository ${repo} in ${targetDir}...`, 'workspace');
    try {
      // Pull latest main branch to be in sync
      let checkoutResult = spawnSync('git', ['checkout', 'main'], {
        cwd: targetDir,
        stdio: 'ignore',
        shell: false,
      });
      if (checkoutResult.status !== 0) {
        checkoutResult = spawnSync('git', ['checkout', 'master'], {
          cwd: targetDir,
          stdio: 'ignore',
          shell: false,
        });
      }
      const pullResult = spawnSync('git', ['pull'], {
        cwd: targetDir,
        stdio: 'ignore',
        shell: false,
      });
      if (pullResult.status !== 0) {
        throw new Error(`git pull failed with status ${pullResult.status}`);
      }
      logger.success(`Repository ${repo} updated.`, 'workspace');
    } catch (_error) {
      logger.warn(
        `Failed to update/pull latest on ${repo}. Will proceed with current state.`,
        'workspace',
      );
    }
  }

  return targetDir;
}

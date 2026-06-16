import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { AppConfig } from '../core/index.js';
import { logger } from '../core/index.js';

/**
 * @what 指定されたリポジトリのベースとなるクローン（ローカルマスターコピー）を `workspaces/<repoFolder>/base` に確保・同期します。
 * @why 全てのタスクが worktree として派生する起点であり、最新のリモート変更を一括で受け取る共通のキャッシュとして機能させるため。
 */
export function ensureBaseRepo(repo: string, config: AppConfig): string {
  const repoFolder = repo.split('/').pop() ?? repo;
  const baseDir = path.resolve(config.workspacesDir, repoFolder, 'base');

  if (!fs.existsSync(config.workspacesDir)) {
    fs.mkdirSync(config.workspacesDir, { recursive: true });
  }

  const repoParentDir = path.resolve(config.workspacesDir, repoFolder);
  if (!fs.existsSync(repoParentDir)) {
    fs.mkdirSync(repoParentDir, { recursive: true });
  }

  if (!fs.existsSync(baseDir)) {
    logger.info(`Cloning repository ${repo} to base repository ${baseDir}...`, 'workspace');
    try {
      const result = spawnSync('gh', ['repo', 'clone', repo, baseDir], {
        stdio: 'inherit',
        shell: false,
      });
      if (result.status !== 0) {
        throw new Error(`gh repo clone failed with status ${result.status}`);
      }
      // Set head remote to allow symbolic ref lookup offline
      spawnSync('git', ['remote', 'set-head', 'origin', '-a'], {
        cwd: baseDir,
        stdio: 'ignore',
        shell: false,
      });
      logger.success(`Base repository ${repo} cloned successfully.`, 'workspace');
    } catch (error) {
      logger.error(`Failed to clone repository ${repo}`, 'workspace', error);
      throw error;
    }
  } else {
    logger.info(`Updating base repository ${repo} in ${baseDir}...`, 'workspace');
    try {
      const defaultBranch = getDefaultBranch(baseDir);
      spawnSync('git', ['checkout', defaultBranch], {
        cwd: baseDir,
        stdio: 'ignore',
        shell: false,
      });
      const pullResult = spawnSync('git', ['pull'], {
        cwd: baseDir,
        stdio: 'ignore',
        shell: false,
      });
      if (pullResult.status !== 0) {
        throw new Error(`git pull failed with status ${pullResult.status}`);
      }
      // Update remote set-head symbolic ref just in case
      spawnSync('git', ['remote', 'set-head', 'origin', '-a'], {
        cwd: baseDir,
        stdio: 'ignore',
        shell: false,
      });
      logger.success(`Base repository ${repo} updated.`, 'workspace');
    } catch (error) {
      logger.warn(
        `Failed to update base repository ${repo}. Will proceed with current state.`,
        'workspace',
        error,
      );
    }
  }

  return baseDir;
}

/**
 * @what ローカルのベースリポジトリから、リモートのデフォルトブランチ（HEAD）名を取得します。
 * @why ハードコード（main/master）されたブランチによる例外を防ぎ、あらゆるリポジトリのデフォルトブランチから安全に作業ブランチを切るため。
 */
export function getDefaultBranch(baseDir: string): string {
  try {
    const result = spawnSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: baseDir,
      encoding: 'utf-8',
      shell: false,
    });
    if (result.status === 0 && result.stdout.trim()) {
      const ref = result.stdout.trim(); // 例: "origin/master" または "origin/main"
      return ref.replace(/^origin\//, '');
    }
  } catch (error) {
    logger.warn(
      'Failed to detect default branch via symbolic ref. Falling back to master.',
      'workspace',
      error,
    );
  }
  return 'master';
}

/**
 * @what 特定のIssue番号またはPR番号に対応する個別の作業ディレクトリ (Git Worktree) を切り出します。
 * @why 複数のエージェントが異なるタスクを並列して実行する際、ファイル変更、ブランチ切り替え、ローカルビルドファイル等の競合を完全に防ぐため。
 */
export function setupWorktree(
  repo: string,
  taskNumber: number | string,
  branchName: string,
  isPR: boolean,
  config: AppConfig,
): string {
  const repoFolder = repo.split('/').pop() ?? repo;
  const baseDir = ensureBaseRepo(repo, config);
  const taskDir = path.resolve(config.workspacesDir, repoFolder, `task-${taskNumber}`);

  // Create log directory outside worktrees to prevent git tracking issues
  const logDir = path.resolve(config.workspacesDir, repoFolder, 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  // If worktree already exists (from an interrupted run), remove it cleanly first
  if (fs.existsSync(taskDir)) {
    logger.info(`Worktree folder already exists at ${taskDir}. Cleaning it up...`, 'workspace');
    cleanupWorktree(repo, taskNumber, config);
  }

  const defaultBranch = getDefaultBranch(baseDir);

  // Sync base repo branch
  spawnSync('git', ['checkout', defaultBranch], {
    cwd: baseDir,
    stdio: 'ignore',
    shell: false,
  });
  spawnSync('git', ['pull'], {
    cwd: baseDir,
    stdio: 'ignore',
    shell: false,
  });

  if (isPR) {
    logger.info(`Creating detached worktree at ${taskDir} for PR #${taskNumber}...`, 'workspace');
    // For PRs, add a detached worktree first, then checkout the PR branch inside the worktree
    const addResult = spawnSync(
      'git',
      ['worktree', 'add', '--detach', taskDir, `origin/${defaultBranch}`],
      {
        cwd: baseDir,
        stdio: 'ignore',
        shell: false,
      },
    );
    if (addResult.status !== 0) {
      throw new Error(`Failed to create worktree for PR #${taskNumber}`);
    }

    logger.info(`Checking out PR #${taskNumber} in worktree...`, 'workspace');
    const checkoutResult = spawnSync('gh', ['pr', 'checkout', String(taskNumber)], {
      cwd: taskDir,
      stdio: 'ignore',
      shell: false,
    });
    if (checkoutResult.status !== 0) {
      throw new Error(`Failed to checkout PR #${taskNumber} inside worktree`);
    }
  } else {
    logger.info(`Creating worktree at ${taskDir} for branch ${branchName}...`, 'workspace');
    // Ensure local branch does not exist in base repo to prevent checkout/tracking conflicts
    spawnSync('git', ['branch', '-D', branchName], {
      cwd: baseDir,
      stdio: 'ignore',
      shell: false,
    });

    const addResult = spawnSync(
      'git',
      ['worktree', 'add', '-b', branchName, taskDir, `origin/${defaultBranch}`],
      {
        cwd: baseDir,
        stdio: 'ignore',
        shell: false,
      },
    );
    if (addResult.status !== 0) {
      throw new Error(`Failed to create worktree for branch ${branchName} at ${taskDir}`);
    }
  }

  return taskDir;
}

/**
 * @what 不要になった Git Worktree を安全に削除し、未整理の参照をクリーンアップ (git worktree prune) します。
 * @why ディスク容量の圧迫を防ぎ、次回同じタスクが実行される際にクリーンな状態から作業を開始できるようにするため。
 */
export function cleanupWorktree(
  repo: string,
  taskNumber: number | string,
  config: AppConfig,
): void {
  const repoFolder = repo.split('/').pop() ?? repo;
  const baseDir = path.resolve(config.workspacesDir, repoFolder, 'base');
  const taskDir = path.resolve(config.workspacesDir, repoFolder, `task-${taskNumber}`);

  if (
    fs.existsSync(taskDir) ||
    fs.existsSync(path.resolve(baseDir, '.git/worktrees', `task-${taskNumber}`))
  ) {
    logger.info(`Removing worktree at ${taskDir}...`, 'workspace');
    spawnSync('git', ['worktree', 'remove', '--force', taskDir], {
      cwd: baseDir,
      stdio: 'ignore',
      shell: false,
    });

    if (fs.existsSync(taskDir)) {
      try {
        fs.rmSync(taskDir, { recursive: true, force: true });
      } catch (err) {
        logger.warn(`Failed to forcefully remove task directory ${taskDir}`, 'workspace', err);
      }
    }
  }

  // Prune registered worktrees list to clean up refs
  spawnSync('git', ['worktree', 'prune'], {
    cwd: baseDir,
    stdio: 'ignore',
    shell: false,
  });
}

/**
 * @what ワークスペースを確保する互換性のためのラッパー関数です。
 * @why 以前のコードベースとの互換性を維持するため。
 */
export function ensureWorkspace(repo: string, config: AppConfig): string {
  return ensureBaseRepo(repo, config);
}

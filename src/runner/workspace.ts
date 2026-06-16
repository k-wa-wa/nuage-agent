import * as fs from 'fs';
import * as path from 'path';
import { spawnSync } from 'child_process';
import type { AppConfig } from '../core/index.js';
import { logger } from '../core/index.js';

/**
 * @what ワークツリーを作成・初期化する際の詳細な設定オプションインターフェース。
 * @why 関数のパラメータ数を上限（4個）以内に抑えて可読性を高めるため。
 */
export interface WorktreeOptions {
  repo: string;
  taskNumber: number | string;
  branchName: string;
  isPR: boolean;
  prNumber?: number;
}

/**
 * @what ベースリポジトリを指定されたディレクトリにクローンします。
 * @why リモートリポジトリの完全なコピーをローカルに確保するため。
 */
function cloneBaseRepo(repo: string, baseDir: string): void {
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
}

/**
 * @what 既存のベースリポジトリを指定されたデフォルトブランチに切り替え、最新化します。
 * @why リモートで発生した最新のコミットを取り込み同期するため。
 */
function updateBaseRepo(baseDir: string): void {
  logger.info(`Updating base repository in ${baseDir}...`, 'workspace');
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
    logger.success(`Base repository updated.`, 'workspace');
  } catch (error) {
    logger.warn(
      `Failed to update base repository. Will proceed with current state.`,
      'workspace',
      error,
    );
  }
}

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
    cloneBaseRepo(repo, baseDir);
  } else {
    updateBaseRepo(baseDir);
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
 * @what PR用のデタッチドワークツリーを作成し、PRのコミットをチェックアウトします。
 * @why PRブランチをクリーンな隔離環境にチェックアウトしてテストや検証を行うため。
 */
function setupWorktreePR(baseDir: string, taskDir: string, prNumber: number | string): void {
  logger.info(`Fetching PR #${prNumber} from origin...`, 'workspace');
  const fetchResult = spawnSync('git', ['fetch', 'origin', `pull/${prNumber}/head`], {
    cwd: baseDir,
    stdio: 'ignore',
    shell: false,
  });
  if (fetchResult.status !== 0) {
    throw new Error(`Failed to fetch PR #${prNumber} from origin`);
  }

  logger.info(`Creating detached worktree at ${taskDir} for PR #${prNumber}...`, 'workspace');
  const addResult = spawnSync('git', ['worktree', 'add', '--detach', taskDir, 'FETCH_HEAD'], {
    cwd: baseDir,
    stdio: 'ignore',
    shell: false,
  });
  if (addResult.status !== 0) {
    throw new Error(`Failed to create worktree for PR #${prNumber} at FETCH_HEAD`);
  }
}

/**
 * @what 通常のIssue開発用の新規ブランチを持つワークツリーを作成します。
 * @why 重複したブランチ作成エラーを防ぎ、デフォルトブランチから新規開発用の枝を切るため。
 */
function setupWorktreeBranch(
  baseDir: string,
  taskDir: string,
  branchName: string,
  defaultBranch: string,
): void {
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

/**
 * @what 特定のIssue番号またはPR番号に対応する個別の作業ディレクトリ (Git Worktree) を切り出します。
 * @why 複数のエージェントが異なるタスクを並列して実行する際、ファイル変更、ブランチ切り替え、ローカルビルドファイル等の競合を完全に防ぐため。
 */
export function setupWorktree(config: AppConfig, options: WorktreeOptions): string {
  const { repo, taskNumber, branchName, isPR, prNumber } = options;
  const repoFolder = repo.split('/').pop() ?? repo;
  const baseDir = ensureBaseRepo(repo, config);
  const taskDir = path.resolve(config.workspacesDir, repoFolder, `task-${taskNumber}`);

  const logDir = path.resolve(config.workspacesDir, repoFolder, 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  if (fs.existsSync(taskDir)) {
    logger.info(`Worktree folder already exists at ${taskDir}. Cleaning it up...`, 'workspace');
    cleanupWorktree(repo, taskNumber, config);
  }

  const defaultBranch = getDefaultBranch(baseDir);
  spawnSync('git', ['checkout', defaultBranch], { cwd: baseDir, stdio: 'ignore', shell: false });
  spawnSync('git', ['pull'], { cwd: baseDir, stdio: 'ignore', shell: false });

  if (isPR) {
    setupWorktreePR(baseDir, taskDir, prNumber ?? taskNumber);
  } else {
    setupWorktreeBranch(baseDir, taskDir, branchName, defaultBranch);
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

  spawnSync('git', ['worktree', 'prune'], { cwd: baseDir, stdio: 'ignore', shell: false });
}

/**
 * @what ワークスペースを確保する互換性のためのラッパー関数です。
 * @why 以前のコードベースとの互換性を維持するため。
 */
export function ensureWorkspace(repo: string, config: AppConfig): string {
  return ensureBaseRepo(repo, config);
}

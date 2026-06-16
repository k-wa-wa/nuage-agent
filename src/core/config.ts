import * as fs from 'fs';
import * as path from 'path';
import type { AppConfig } from './types.js';
import { logger } from './logger.js';

// --- SYSTEM STATIC CONSTANTS ---
export const DEFAULT_POLLING_INTERVAL_SECONDS = 60;
export const DEFAULT_CLAUDE_COMMAND = '~/.local/bin/claude';
export const DEFAULT_CLAUDE_FLAGS = ['--dangerously-skip-permissions'];
export const DEFAULT_GEMINI_COMMAND = '~/.local/bin/agy';
export const DEFAULT_GEMINI_FLAGS = ['--dangerously-skip-permissions'];
export const DEFAULT_WORKSPACES_DIR_NAME = 'workspaces';

/**
 * @what YAML形式の設定ファイルから、監視対象リポジトリ名のリスト（例: owner/repo）を抽出してパースします。
 * @why 依存ライブラリを追加せずにシンプルかつ堅牢にリポジトリ設定配列をロードするため。
 */
function parseYamlRepositories(content: string): string[] {
  const repos: string[] = [];
  const lines = content.split('\n');
  let inRepositories = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // Detect repositories block
    if (trimmed.startsWith('repositories:')) {
      inRepositories = true;
      continue;
    }

    if (inRepositories) {
      // If we encounter a new root-level key (line with no leading dash and contains ':'), stop
      if (trimmed.includes(':') && !trimmed.startsWith('-')) {
        break;
      }
      // Parse list item (e.g., "- owner/repo-name")
      if (trimmed.startsWith('-')) {
        const repo = trimmed.substring(1).trim().replace(/['"]/g, '');
        if (repo) {
          repos.push(repo);
        }
      }
    }
  }

  return repos;
}

/**
 * @what アプリケーション起動時の引数（-d, --repo-map-dir）を検証してロードし、対象リポジトリ一覧やCLIパスなどの構成設定オブジェクト（AppConfig）を生成します。
 * @why 実行環境（Sandbox / Production）ごとの設定を間違えることのないよう明示的な引数入力を必須とし、システム定数と統合した設定を安全に配るため。
 */
export function loadConfig(): AppConfig {
  const rootDir = process.cwd();
  logger.debug(`Detected workspace root directory: ${rootDir}`, 'config');

  // Parse command line arguments for --repo-map-dir or -d
  const args = process.argv;
  let repoMapDirIndex = args.indexOf('--repo-map-dir');
  if (repoMapDirIndex === -1) {
    repoMapDirIndex = args.indexOf('-d');
  }

  // Strictly require --repo-map-dir / -d parameter
  if (repoMapDirIndex === -1 || !args[repoMapDirIndex + 1]) {
    throw new Error(
      'Error: --repo-map-dir (または -d) パラメータは必須です。デフォルト値はありません。\n' +
        '実行例:\n' +
        '  pnpm dev:runner -- --repo-map-dir ./repo-map/sandbox\n' +
        '  pnpm dev:runner -- --repo-map-dir ./repo-map/production',
    );
  }

  const repoMapDir = args[repoMapDirIndex + 1];
  const resolvedRepoMapDir = path.isAbsolute(repoMapDir)
    ? repoMapDir
    : path.resolve(rootDir, repoMapDir);

  if (!fs.existsSync(resolvedRepoMapDir)) {
    throw new Error(`Repo-map directory not found at: ${resolvedRepoMapDir}`);
  }

  // Look for config.yaml or repositories.yaml in the specified directory
  let yamlPath = path.join(resolvedRepoMapDir, 'config.yaml');
  if (!fs.existsSync(yamlPath)) {
    yamlPath = path.join(resolvedRepoMapDir, 'repositories.yaml');
  }

  if (!fs.existsSync(yamlPath)) {
    throw new Error(`No config.yaml or repositories.yaml found under ${resolvedRepoMapDir}`);
  }

  try {
    const yamlData = fs.readFileSync(yamlPath, 'utf-8');
    const repositories = parseYamlRepositories(yamlData);

    logger.info(`Loaded repositories from ${yamlPath}: [${repositories.join(', ')}]`, 'config');

    const autoMerge = args.includes('--auto-merge');
    logger.info(`QA Agent Auto Merge: ${autoMerge}`, 'config');

    // Parse QA issues configuration from CLI
    let qaIntervalIndex = args.indexOf('--qa-interval');
    if (qaIntervalIndex === -1) {
      qaIntervalIndex = args.indexOf('-i');
    }
    const qaInterval = qaIntervalIndex !== -1 ? parseInt(args[qaIntervalIndex + 1], 10) : 1440; // Default: 1 day = 1440 minutes

    const qaPrefixIndex = args.indexOf('--qa-prefix');
    const qaPrefix = qaPrefixIndex !== -1 ? args[qaPrefixIndex + 1] : '[QA-Improve]';

    logger.info(`QA Issue Interval: ${qaInterval} minutes, Prefix: "${qaPrefix}"`, 'config');

    return {
      repositories,
      repoMapDir: resolvedRepoMapDir,
      pollingIntervalSeconds: DEFAULT_POLLING_INTERVAL_SECONDS,
      claudeCommand: DEFAULT_CLAUDE_COMMAND,
      claudeFlags: DEFAULT_CLAUDE_FLAGS,
      geminiCommand: DEFAULT_GEMINI_COMMAND,
      geminiFlags: DEFAULT_GEMINI_FLAGS,
      workspacesDir: path.resolve(rootDir, DEFAULT_WORKSPACES_DIR_NAME),
      qaAutoMerge: autoMerge,
      qaIssueIntervalMinutes: qaInterval,
      qaIssuePrefix: qaPrefix,
    };
  } catch (error) {
    throw new Error(`Failed to load and parse repo-map configuration: ${String(error)}`, {
      cause: error,
    });
  }
}

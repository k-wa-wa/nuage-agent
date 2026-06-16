import * as fs from 'fs';
import * as path from 'path';
import { load } from 'js-yaml';
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
 * @why js-yaml ライブラリを使用することで、YAMLパーサーを手動で実装する複雑さとバグの発生リスクを排除するため。
 */
function parseYamlRepositories(content: string): string[] {
  const parsed = load(content) as { repositories?: string[] } | null;
  if (!parsed || !Array.isArray(parsed.repositories)) {
    return [];
  }
  return parsed.repositories;
}

/**
 * @what コマンドライン引数から指定された複数のフラグ名に対応するパラメータ値を取得します。
 * @why 重複する引数抽出処理を一元化し、関数全体のコード行数を削減するため。
 */
function findArg(names: string[]): string | undefined {
  const args = process.argv;
  for (const name of names) {
    const index = args.indexOf(name);
    if (index !== -1 && args[index + 1]) {
      return args[index + 1];
    }
  }
  return undefined;
}

/**
 * @what 引数から設定用ディレクトリパスを抽出し、絶対パスに解決・存在チェックを行います。
 * @why 必須である repo-map ディレクトリの正常存在を早期に強制チェックするため。
 */
function getRepoMapDir(rootDir: string): string {
  const val = findArg(['--repo-map-dir', '-d']);
  if (!val) {
    throw new Error(
      'Error: --repo-map-dir (または -d) パラメータは必須です。デフォルト値はありません。\n' +
        '実行例:\n' +
        '  pnpm dev:runner -- --repo-map-dir ./repo-map/sandbox',
    );
  }
  const resolved = path.isAbsolute(val) ? val : path.resolve(rootDir, val);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Repo-map directory not found at: ${resolved}`);
  }
  return resolved;
}

/**
 * @what ディレクトリ内の設定ファイル（config.yaml または repositories.yaml）のパスを解決します。
 * @why YAML設定ファイルが存在しない場合に適切な例外を送出するため。
 */
function getYamlPath(repoMapDir: string): string {
  let yamlPath = path.join(repoMapDir, 'config.yaml');
  if (!fs.existsSync(yamlPath)) {
    yamlPath = path.join(repoMapDir, 'repositories.yaml');
  }
  if (!fs.existsSync(yamlPath)) {
    throw new Error(`No config.yaml or repositories.yaml found under ${repoMapDir}`);
  }
  return yamlPath;
}

/**
 * @what アプリケーション起動時の引数を検証してロードし、構成設定オブジェクト（AppConfig）を生成します。
 * @why 実行環境（Sandbox / Production）ごとの設定を間違えることのないよう明示的な引数入力を必須とし、設定を安全に配るため。
 */
export function loadConfig(): AppConfig {
  const rootDir = process.cwd();
  logger.debug(`Detected workspace root directory: ${rootDir}`, 'config');

  const repoMapDir = getRepoMapDir(rootDir);
  const yamlPath = getYamlPath(repoMapDir);

  try {
    const yamlData = fs.readFileSync(yamlPath, 'utf-8');
    const repositories = parseYamlRepositories(yamlData);
    logger.info(`Loaded repositories from ${yamlPath}: [${repositories.join(', ')}]`, 'config');

    const autoMerge = process.argv.includes('--auto-merge');
    const qaIntervalStr = findArg(['--qa-interval', '-i']);
    const qaInterval = qaIntervalStr ? parseInt(qaIntervalStr, 10) : 1440;
    const qaPrefix = findArg(['--qa-prefix']) ?? '[QA-Improve]';

    logger.info(`QA Issue Interval: ${qaInterval} minutes, Prefix: "${qaPrefix}"`, 'config');

    return {
      repositories,
      repoMapDir,
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

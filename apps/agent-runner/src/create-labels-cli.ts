import { loadConfig, logger } from '@nuage-agent/core';
import { ensureLabelsExist } from './github-client.js';

/**
 * @what 設定ファイルで指定されたリポジトリそれぞれに対して、GitHub 上で必要なパイプライン状態ラベルの一括作成処理を実行します。
 * @why ランナーが通常実行される時とは異なる「特権（書き込み権限のあるマスターアカウント）」を用いて、あらかじめ必要なラベルを冪等に用意しておくため。
 */
async function main() {
  logger.info('Starting pipeline label creator...', 'labels-cli');

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error('Failed to load configuration', 'labels-cli', error);
    process.exit(1);
  }

  logger.info(`Found ${config.repositories.length} repositories in configuration.`, 'labels-cli');

  for (const repo of config.repositories) {
    try {
      await ensureLabelsExist(repo);
      logger.success(`Successfully ensured labels for repository: ${repo}`, 'labels-cli');
    } catch (error) {
      logger.error(`Failed to ensure labels for repository: ${repo}`, 'labels-cli', error);
    }
  }

  logger.info('Pipeline label creator completed.', 'labels-cli');
}

main().catch((error: unknown) => {
  logger.error('Fatal error in pipeline label creator', 'labels-cli', error);
  process.exit(1);
});

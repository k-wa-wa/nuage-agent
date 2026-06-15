import { loadConfig, logger } from '../core/index.js';
import { PipelineCrawler } from './crawler.js';
import { PipelineSupervisor } from './supervisor.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @what アプリケーションのエントリーポイントであり、デーモンモード（常駐監視）またはシングルサイクルモード（使い捨て）で巡回プロセスを起動します。
 * @why コマンドライン引数を読み込み、Supervisor監視とクローラー監視の2つの役割（状態チェックおよびフリーズ復旧）を順次または無限ループで実行し続けるため。
 */
async function main() {
  logger.info('Initializing nuage-agent runner...', 'main');

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error('Failed to load configuration', 'main', error);
    process.exit(1);
  }

  const crawler = new PipelineCrawler(config);
  const supervisor = new PipelineSupervisor(config);

  // Check if --once flag is passed for single execution
  const runOnce = process.argv.includes('--once') || process.argv.includes('-o');

  if (runOnce) {
    logger.info('Running single crawl and supervisor cycle...', 'main');
    await supervisor.runSupervisorChecks();
    await crawler.crawlCycle();
    logger.info('Single cycle finished. Exiting.', 'main');
    process.exit(0);
  }

  logger.info(
    `Starting in daemon mode. Polling interval: ${config.pollingIntervalSeconds}s`,
    'main',
  );

  for (;;) {
    try {
      // 1. Run supervisor checklist (timeouts, unlabeled issues)
      await supervisor.runSupervisorChecks();

      // 2. Run crawler check cycle (triggers spec, dev, review, qa agents)
      await crawler.crawlCycle();
    } catch (error: unknown) {
      logger.error('Unhandled error in runner loop', 'main', error);
    }

    logger.debug(`Sleeping for ${config.pollingIntervalSeconds} seconds...`, 'main');
    await sleep(config.pollingIntervalSeconds * 1000);
  }
}

main().catch((error: unknown) => {
  logger.error('Fatal runner error', 'main', error);
  process.exit(1);
});

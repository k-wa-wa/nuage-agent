import { loadConfig, logger } from '@nuage-agent/core';
import { PipelineCrawler } from './crawler.js';
import { PipelineSupervisor } from './supervisor.js';
import { ensureLabelsExist } from './github-client.js';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  logger.info('Initializing nuage-agent runner...', 'main');

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error('Failed to load configuration', 'main', error);
    process.exit(1);
  }

  // Ensure pipeline labels exist in all registered repositories
  logger.info('Checking and initializing repository labels on GitHub...', 'main');
  for (const repo of config.repositories) {
    try {
      await ensureLabelsExist(repo);
    } catch (err) {
      logger.error(`Failed to ensure labels for repository: ${repo}`, 'main', err);
    }
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

  logger.info(`Starting in daemon mode. Polling interval: ${config.pollingIntervalSeconds}s`, 'main');
  
  while (true) {
    try {
      // 1. Run supervisor checklist (timeouts, unlabeled issues)
      await supervisor.runSupervisorChecks();

      // 2. Run crawler check cycle (triggers spec, dev, review, qa agents)
      await crawler.crawlCycle();
    } catch (error) {
      logger.error('Unhandled error in runner loop', 'main', error);
    }

    logger.debug(`Sleeping for ${config.pollingIntervalSeconds} seconds...`, 'main');
    await sleep(config.pollingIntervalSeconds * 1000);
  }
}

main().catch((error) => {
  logger.error('Fatal runner error', 'main', error);
  process.exit(1);
});

import { loadConfig, logger } from '../../core/index.js';
import { PipelineCrawler } from '../core/crawler.js';
import { PipelineSupervisor } from '../core/supervisor.js';
import { registerShutdownHandlers } from '../tasks/pool.js';
import { initTui, stopTui, setRepos } from '../tui/index.js';
import { getViewerLogin, verifyRepositoryAndEnsureLabels } from '../../github/index.js';

/**
 * @what 指定されたミリ秒数だけ非同期プロセスを停止するスリープ関数。
 * @why ポーリングループでクローラー実行間に待機時間を挟むため。
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @what アプリケーションのエントリーポイントであり、デーモンモード（常駐監視）またはシングルサイクルモード（使い捨て）で巡回プロセスを起動します。
 * @why コマンドライン引数を読み込み、Supervisor監視とクローラー監視の2つの役割（状態チェックおよびフリーズ復旧）を順次または無限ループで実行し続けるため。
 */
/**
 * @what 設定されたリポジトリの検証およびラベル確認を行い、有効なリポジトリのみをフィルタリングして返します。
 * @why main関数の行数・複雑度を削減し、コードの可読性を高めるため。
 */
async function verifyConfiguredRepositories(repositories: string[]): Promise<string[]> {
  const verifiedRepos: string[] = [];
  logger.info(
    `Starting dryrun and label verification for ${repositories.length} repositories...`,
    'main',
  );
  for (const repo of repositories) {
    const success = await verifyRepositoryAndEnsureLabels(repo);
    if (success) {
      verifiedRepos.push(repo);
    } else {
      logger.warn(`Skipping repository ${repo} as it failed verification / dryrun checks.`, 'main');
    }
  }
  return verifiedRepos;
}

/**
 * @what 常駐監視（デーモン）モードでクローラーとスーパーバイザーをポーリング実行します。
 * @why main関数の行数制限と複雑度制限（10以下）を遵守するため。
 */
async function runDaemon(
  crawler: PipelineCrawler,
  supervisor: PipelineSupervisor,
  pollingIntervalSeconds: number,
): Promise<never> {
  for (;;) {
    try {
      // 1. Run supervisor checklist (timeouts, unlabeled issues)
      await supervisor.runSupervisorChecks();

      // 2. Run crawler check cycle (triggers spec, dev, review, qa agents)
      await crawler.crawlCycle();
    } catch (error: unknown) {
      logger.error('Unhandled error in runner loop', 'main', error);
    }

    logger.debug(`Sleeping for ${pollingIntervalSeconds} seconds...`, 'main');
    await sleep(pollingIntervalSeconds * 1000);
  }
}

/**
 * @what アプリケーションのエントリーポイントであり、デーモンモード（常駐監視）またはシングルサイクルモード（使い捨て）で巡回プロセスを起動します。
 * @why コマンドライン引数を読み込み、Supervisor監視とクローラー監視の2つの役割（状態チェックおよびフリーズ復旧）を順次または無限ループで実行し続けるため。
 */
/**
 * @what TUIを必要に応じて起動し、初期状態を設定します。
 * @why main関数の複雑度と行数を削減するため。
 */
async function tryInitTui(useTui: boolean, initialRepos: string[]): Promise<void> {
  if (useTui) {
    await initTui();
    setRepos(initialRepos);
  }
}

/**
 * @what 有効なリポジトリが1つも無かった場合に、TUIを停止しエラー終了します。
 * @why main関数の複雑度と行数を削減するため。
 */
function handleNoVerifiedRepositories(useTui: boolean): never {
  logger.error('No repositories passed verification. Exiting.', 'main');
  if (useTui) {
    stopTui();
  }
  console.error('✘ Error: No repositories passed verification. Exiting nuage-agent.');
  process.exit(1);
}

/**
 * @what アプリケーションのエントリーポイントであり、デーモンモード（常駐監視）またはシングルサイクルモード（使い捨て）で巡回プロセスを起動します。
 * @why コマンドライン引数を読み込み、Supervisor監視とクローラー監視の2つの役割（状態チェックおよびフリーズ復旧）を順次または無限ループで実行し続けるため。
 */
async function main() {
  registerShutdownHandlers();
  logger.info('Initializing nuage-agent runner...', 'main');

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error('Failed to load configuration', 'main', error);
    process.exit(1);
  }

  // Check execution mode and start TUI as early as possible
  const runOnce = process.argv.includes('--once') || process.argv.includes('-o');
  const useTui = !runOnce && process.stdout.isTTY && !process.argv.includes('--no-tui');
  await tryInitTui(useTui, config.repositories);

  // Prefetch and cache GitHub viewer login info
  try {
    const viewer = await getViewerLogin();
    logger.info(`Authenticated as GitHub user: ${viewer}`, 'main');
  } catch (error) {
    logger.warn('Failed to prefetch GitHub viewer login', 'main', error);
  }

  // Verify all configured repositories and ensure labels exist
  const verifiedRepos = await verifyConfiguredRepositories(config.repositories);

  if (verifiedRepos.length === 0) {
    handleNoVerifiedRepositories(useTui);
  }

  config.repositories = verifiedRepos;
  if (useTui) {
    setRepos(config.repositories);
  }

  const crawler = new PipelineCrawler(config);
  const supervisor = new PipelineSupervisor(config);

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

  await runDaemon(crawler, supervisor, config.pollingIntervalSeconds);
}

main().catch((error: unknown) => {
  logger.error('Fatal runner error', 'main', error);
  process.exit(1);
});

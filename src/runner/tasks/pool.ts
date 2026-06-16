import { logger } from '../../core/index.js';

/**
 * @what シャットダウン中であるかどうかを示すフラグ。
 * @why シグナル受信時に追加のタスク開始を防ぐため。
 */
let isShuttingDown = false;

/**
 * @what シャットダウンフラグを設定します。
 * @why 他のモジュールからシャットダウン状態を動的に変更するため。
 */
export function setShuttingDown(val: boolean): void {
  isShuttingDown = val;
}

/**
 * @what 現在のシャットダウン状態を取得します。
 * @why 新規タスクの実行開始を抑制すべきかを判断するため。
 */
export function getShuttingDown(): boolean {
  return isShuttingDown;
}

/**
 * @what 並行実行されるタスク数を制御する汎用タスクプールクラス。
 * @why ポート競合の考慮有無に応じた同時実行数の制限を適用するため。
 */
export class TaskPool {
  /**
   * @what 最大同時実行数。
   * @why プール作成時に指定された並行制限を保持するため。
   */
  private concurrency: number;

  /**
   * @what 実行待ちタスクのキュー。
   * @why 実行上限に達している場合に処理を一時ストックするため。
   */
  private queue: (() => Promise<void>)[] = [];

  /**
   * @what 現在実行中のタスク数。
   * @why 並行実行数が制限値に達しているかを判定するため。
   */
  private activeCount = 0;

  /**
   * @what 現在実行中のタスクのPromiseセット。
   * @why シャットダウン時に実行中処理の完了を待機 (drain) できるようにするため。
   */
  private activePromises = new Set<Promise<void>>();

  /**
   * @what プール内の全タスク完了を待つリスナーのコールバック配列。
   * @why キューおよび実行中タスクが空になったタイミングで待機元に通知するため。
   */
  private idleResolvers: (() => void)[] = [];

  /**
   * @what 指定した同時実行数でタスクプールを初期化します。
   * @why ポート制限等に基づくプール固有の並行制限を設定するため。
   */
  constructor(concurrency: number) {
    this.concurrency = concurrency;
  }

  /**
   * @what 現在キューに格納されている待機中タスク数を取得します。
   * @why キューの残量を外部から監視するため。
   */
  public get size(): number {
    return this.queue.length;
  }

  /**
   * @what 現在並行して稼働中のアクティブタスク数を取得します。
   * @why 実行状況をロギングまたはテストするため。
   */
  public get active(): number {
    return this.activeCount;
  }

  /**
   * @what 新しい非同期タスクをプールに登録します。
   * @why シャットダウン中でなければキューに追加し、即座に次の実行機会を探るため。
   */
  public enqueue(task: () => Promise<void>): void {
    if (isShuttingDown) {
      logger.warn('Pool: Rejecting task enqueue because shutdown is in progress.', 'pool');
      return;
    }
    this.queue.push(task);
    this.next();
  }

  /**
   * @what キューから次のタスクを取り出し、同時実行制限の範囲内で実行します。
   * @why タスクの実行と完了後の後続タスク呼び出しを自動でチェーンするため。
   */
  private next(): void {
    if (this.activeCount >= this.concurrency || this.queue.length === 0) {
      this.checkIdle();
      return;
    }

    if (isShuttingDown) {
      logger.info('Pool: Skipping queued task execution due to shutdown.', 'pool');
      this.checkIdle();
      return;
    }

    const task = this.queue.shift();
    if (!task) {
      this.checkIdle();
      return;
    }

    this.activeCount++;
    const promise = task()
      .catch((err: unknown) => {
        logger.error('Pool: Task failed', 'pool', err);
      })
      .finally(() => {
        this.activeCount--;
        this.activePromises.delete(promise);
        this.next();
      });

    this.activePromises.add(promise);
  }

  /**
   * @what キューと実行中タスクがともに空になったかを判定し、待機プロミスを解決します。
   * @why 全タスク完了時の待機ブロックを安全に解除するため。
   */
  private checkIdle(): void {
    if (this.activeCount === 0 && this.queue.length === 0) {
      const resolvers = this.idleResolvers;
      this.idleResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
  }

  /**
   * @what キューに残っている未実行のタスクを破棄し、現在実行中のタスクの完了を待ちます。
   * @why シャットダウン時に新規実行を防ぎつつ、稼働中プロセスの安全な自然終了を待つため。
   */
  public async drain(): Promise<void> {
    this.queue = [];
    if (this.activePromises.size === 0) {
      return;
    }
    await Promise.all(Array.from(this.activePromises));
  }

  /**
   * @what 現在キューにあるタスクおよび実行中のタスクがすべて完了するのを待ちます。
   * @why crawlCycle やテスト完了時に、投げた全処理が終わるまで同期的にブロックするため。
   */
  public async waitForCompletion(): Promise<void> {
    if (this.activeCount === 0 && this.queue.length === 0) {
      return;
    }
    return new Promise<void>((resolve) => {
      this.idleResolvers.push(resolve);
    });
  }
}

/**
 * @what ポートやビルド競合が発生するタスク用のシリアルプール。
 * @why 重いテスト処理などを同時実行数1で順次実行するため。
 */
export const conflictPool = new TaskPool(1);

/**
 * @what 競合が発生しないAPI・レビュー用タスクの並行プール。
 * @why ポート等を使わない軽量処理を同時実行数3で並行稼働させるため。
 */
export const nonConflictPool = new TaskPool(3);

/**
 * @what 現在実行またはキュー登録されているタスクのキーセット。
 * @why 重複するIssue/PRが二重にキューに入り実行されるのを防ぐため。
 */
const activeTaskKeys = new Set<string>();

/**
 * @what 指定したキーのタスクがアクティブ（キュー内または実行中）か判定します。
 * @why 二重登録のスキップ判定を効率的に行うため。
 */
export function isTaskActive(key: string): boolean {
  return activeTaskKeys.has(key);
}

/**
 * @what タスクをアクティブセットに追加します。
 * @why 実行開始・キュー投入されたタスクを追跡するため。
 */
export function addTaskActive(key: string): void {
  activeTaskKeys.add(key);
}

/**
 * @what タスクをアクティブセットから削除します。
 * @why 完了したタスクのキーを解放し、再度の実行を可能にするため。
 */
export function removeTaskActive(key: string): void {
  activeTaskKeys.delete(key);
}

/**
 * @what シグナルハンドラーが登録済みかどうかを示すフラグ。
 * @why 重複してハンドラーを登録し同じシグナルで多重稼働するのを避けるため。
 */
let registered = false;

/**
 * @what プロセスの終了シグナル（SIGINT/SIGTERM）を監視し、実行中タスクの完了を待って終了します。
 * @why 強制終了による一時ディレクトリの残存やGitHubロックの掛けっぱなしを防ぐため。
 */
export function registerShutdownHandlers(): void {
  if (registered) {
    return;
  }
  registered = true;

  const handleSignal = async (signal: string) => {
    if (isShuttingDown) {
      logger.info(`Received ${signal} again. Force exiting...`, 'pool');
      process.exit(1);
    }
    isShuttingDown = true;
    logger.info(`\n[Shutdown] Received ${signal}. Draining running tasks gracefully...`, 'pool');

    // Drain both pools
    await Promise.all([conflictPool.drain(), nonConflictPool.drain()]);

    logger.success('[Shutdown] All running tasks completed. Exiting.', 'pool');
    process.exit(0);
  };

  process.on('SIGINT', () => {
    handleSignal('SIGINT').catch((err: unknown) => {
      logger.error('Error handling SIGINT', 'pool', err);
    });
  });
  process.on('SIGTERM', () => {
    handleSignal('SIGTERM').catch((err: unknown) => {
      logger.error('Error handling SIGTERM', 'pool', err);
    });
  });
}

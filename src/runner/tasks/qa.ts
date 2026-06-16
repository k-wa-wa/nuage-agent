import type { AppConfig } from '../../core/index.js';
import { QAGeneratorAgent } from '../../agents/index.js';
import { runAgentTask } from './task-helper.js';

/**
 * @what QA Generator用タスクを実行するためのオプション。
 * @why 関数のパラメータ数を上限（4個）以内に抑えて可読性を高めるため。
 */
export interface QATaskOptions {
  repo: string;
  config: AppConfig;
  repoMapMd: string;
  prefix: string;
}

/**
 * @what QA Generatorエージェントのライフサイクル全体の実行を制御します。
 * @why 共通の runAgentTask ヘルパーを呼び出して隔離ワークツリー構築・自動起票CLI起動・後処理を統合実行するため。
 */
export async function runQAGeneratorTask(options: QATaskOptions): Promise<void> {
  const { repo, config, repoMapMd, prefix } = options;
  const key = `${repo}#qa-generator`;
  const taskNumber = 'qa-generator';
  const branchName = 'agent/qa-generator';
  const agent = new QAGeneratorAgent(prefix);

  await runAgentTask({
    repo,
    taskKey: key,
    taskNumber,
    agent,
    config,
    branchName,
    isPR: false,
    buildContext: () => ({ repoName: repo, repoMapMd }),
    onStartLog: () => `Starting Proactive QA Generator Agent (QAGeneratorAgent) for ${repo}...`,
  });
}

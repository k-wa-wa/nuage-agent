import * as path from 'path';
import type { AppConfig } from '../../core/index.js';
import type { Agent } from '../../agents/index.js';
import { logger } from '../../core/index.js';

/**
 * @what CLIの実行を構成するための内部パラメータ。
 * @why パラメータ数を減らし、シグネチャを簡素に保つため。
 */
export interface CLIExecutionOptions {
  agent: Agent;
  prompt: string;
  workspacePath: string;
  taskNumber: string;
}

/**
 * @what エージェントCLIの進捗出力をフィルタリングしてコンソールに出力するコールバック関数を生成します。
 * @why 開発進捗をプレフィックス付きで分かりやすくリアルタイムに確認できるようにするため。
 */
function createProgressCallback(repoFolder: string, taskNumber: string, agentId: string) {
  let lastLoggedAction = '';
  const pat = /thinking|calling tool|tool call|executing|tool response|tool result/i;
  return (line: string) => {
    const trimmed = line.trim();
    if (trimmed && pat.test(trimmed) && trimmed !== lastLoggedAction) {
      lastLoggedAction = trimmed;
      logger.info(`[${repoFolder}#${taskNumber} (${agentId})]: ${trimmed}`, 'progress');
    }
  };
}

/**
 * @what 指定されたエージェントの指示プロンプトを引数として LLM CLI に渡し、実行を開始します。
 * @why 複数行に及ぶプロンプトを安全に引き渡し、進捗出力をフィルタリングしてコンソールに表示するため。
 */
export async function executeAgentCLI(config: AppConfig, opts: CLIExecutionOptions): Promise<void> {
  const { agent, prompt, workspacePath, taskNumber } = opts;

  logger.info(`Invoking CLI (${agent.runner.id}) for Agent: ${agent.id}...`, 'crawler');

  const repoFolder = path.basename(path.dirname(workspacePath));
  const logFilePath = path.resolve(
    config.workspacesDir,
    repoFolder,
    'logs',
    `task-${taskNumber}.log`,
  );

  const onProgress = createProgressCallback(repoFolder, taskNumber, agent.id);

  const result = await agent.runner.run({
    prompt,
    cwd: workspacePath,
    logFilePath,
    onProgress,
  });
  logger.debug(`Agent ${agent.id} CLI completed with exit code: ${result.code}`, 'crawler');
}

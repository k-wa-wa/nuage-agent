import type { AppConfig } from '../core/index.js';
import { logger } from '../core/index.js';
import { QAGeneratorAgent } from '../agents/index.js';
import { setupWorktree, cleanupWorktree } from './workspace.js';
import { removeTaskActive } from './pool.js';
import { executeAgentCLI } from './agent-cli.js';
import * as tui from './tui.js';

export interface QATaskOptions {
  repo: string;
  config: AppConfig;
  repoMapMd: string;
  prefix: string;
}

/**
 * @what QA Generator用ブランチのワークツリーを作成し、CLIを実行して後片付けを行います。
 * @why 隔離環境下でQA提案Issue作成コマンドを実行し、完了後に作業資源を解放するため。
 */
async function executeQAGeneratorCLI(taskNumber: string, options: QATaskOptions): Promise<boolean> {
  const { repo, config, repoMapMd, prefix } = options;
  let workspacePath = '';
  let success = true;

  try {
    const branchName = 'agent/qa-generator';
    workspacePath = setupWorktree(config, { repo, taskNumber, branchName, isPR: false });
    const context = { repoName: repo, repoMapMd };
    const agent = new QAGeneratorAgent(prefix);
    const prompt = agent.buildPrompt(context);

    await executeAgentCLI(config, { agent, prompt, workspacePath, taskNumber });
    logger.success(`QA Generator Agent completed successfully.`, 'crawler');
  } catch (error) {
    success = false;
    logger.error(`Failed to run QA Generator Agent on ${repo}`, 'crawler', error);
  } finally {
    if (workspacePath) {
      cleanupWorktree(repo, taskNumber, config);
    }
  }
  return success;
}

/**
 * @what QA Generatorエージェントのライフサイクル全体の実行を制御します。
 * @why 隔離環境確保、CLI起動による自動起票、および後片付けを一貫して行うため。
 */
export async function runQAGeneratorTask(options: QATaskOptions): Promise<void> {
  const { repo } = options;
  const key = `${repo}#qa-generator`;

  try {
    logger.info(
      `Starting Proactive QA Generator Agent (QAGeneratorAgent) for ${repo}...`,
      'crawler',
    );

    const taskNumber = 'qa-generator';
    tui.taskStarted(key);
    const success = await executeQAGeneratorCLI(taskNumber, options);
    tui.taskFinished(key, success);
  } finally {
    removeTaskActive(key);
  }
}

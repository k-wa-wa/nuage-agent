import { runCommand, logger } from '../core/index.js';

const PIPELINE_LABELS = [
  { name: 'agent:spec', color: 'fbca04', description: 'Specification phase' },
  { name: 'agent:dev', color: '1d76db', description: 'Development phase' },
  { name: 'agent:review', color: '0e8a16', description: 'Review phase' },
  { name: 'agent:qa', color: 'b60205', description: 'QA phase' },
  { name: 'agent:triage', color: 'd93f0b', description: 'Triage phase' },
  { name: 'agent:running', color: '5319e7', description: 'Currently running' },
  { name: 'agent:wait', color: '6f42c1', description: 'Waiting for user input/action' },
];

/**
 * @what パイプラインの各フェーズに用いる GitHub ラベルを一括作成・更新（冪等）します。
 * @why ランナーの起動前に確実に状態ラベルが存在することを保証するため。
 */
export async function ensureLabelsExist(repo: string): Promise<void> {
  logger.info(`Ensuring pipeline labels exist for repository: ${repo}`, 'github-client');
  for (const label of PIPELINE_LABELS) {
    try {
      const result = await runCommand({
        cmd: 'gh',
        args: [
          'label',
          'create',
          label.name,
          '--repo',
          repo,
          '--color',
          label.color,
          '--description',
          label.description,
          '--force',
        ],
        cwd: process.cwd(),
      });
      if (result.code !== 0) {
        throw new Error(result.stderr);
      }
    } catch (error) {
      logger.error(
        `Failed to ensure label "${label.name}" exists in ${repo}`,
        'github-client',
        error,
      );
    }
  }
}

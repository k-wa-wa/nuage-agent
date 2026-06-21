import { runCommand, logger } from '../core/index.js';

const PIPELINE_LABELS = [
  { name: 'agent:spec', color: 'fbca04', description: 'Specification phase' },
  { name: 'agent:dev', color: '1d76db', description: 'Development phase' },
  { name: 'agent:review-general', color: '0e8a16', description: 'General review phase' },
  { name: 'agent:review-semantic', color: 'c2e0c6', description: 'Semantic review phase' },
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

/**
 * @what 不足している状態ラベルを検出して作成します。
 * @why 関数の最大行数制限（50行以内）を遵守し、役割を明確にするため。
 */
async function createMissingLabels(repo: string, existingLabels: string[]): Promise<boolean> {
  for (const label of PIPELINE_LABELS) {
    if (!existingLabels.includes(label.name)) {
      logger.info(`Label "${label.name}" is missing in ${repo}. Creating it...`, 'github-client');
      const createResult = await runCommand({
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
        ],
        cwd: process.cwd(),
      });
      if (createResult.code !== 0) {
        logger.error(
          `Failed to create label "${label.name}" in ${repo}: ${createResult.stderr.trim()}`,
          'github-client',
        );
        return false;
      }
      logger.success(`Created label "${label.name}" in ${repo}`, 'github-client');
    }
  }
  return true;
}

/**
 * @what リポジトリの存在、アクセス権限、および必要なラベルの存在を確認し、不足があれば自動で作成します。
 * @why ランナーの起動時に、操作不能なリポジトリを検知して除外するドライラン機能と、ラベル不足時の自動付与を両立するため。
 */
export async function verifyRepositoryAndEnsureLabels(repo: string): Promise<boolean> {
  logger.info(`Checking repository access and labels: ${repo}`, 'github-client');
  try {
    const viewResult = await runCommand({
      cmd: 'gh',
      args: ['repo', 'view', repo, '--json', 'name'],
      cwd: process.cwd(),
    });
    if (viewResult.code !== 0) {
      logger.error(
        `Repository ${repo} is not accessible or does not exist: ${viewResult.stderr.trim()}`,
        'github-client',
      );
      return false;
    }

    const labelResult = await runCommand({
      cmd: 'gh',
      args: ['label', 'list', '--repo', repo, '--json', 'name', '--limit', '100'],
      cwd: process.cwd(),
    });
    if (labelResult.code !== 0) {
      logger.error(
        `Failed to list labels for ${repo}: ${labelResult.stderr.trim()}`,
        'github-client',
      );
      return false;
    }

    let existingLabels: string[] = [];
    try {
      const parsed = JSON.parse(labelResult.stdout) as Array<{ name: string }>;
      if (Array.isArray(parsed)) {
        existingLabels = parsed.map((l) => l.name);
      }
    } catch (e) {
      logger.error(`Failed to parse label list JSON for ${repo}`, 'github-client', e);
      return false;
    }

    return await createMissingLabels(repo, existingLabels);
  } catch (error) {
    logger.error(
      `Unexpected error during repository dryrun check for ${repo}`,
      'github-client',
      error,
    );
    return false;
  }
}

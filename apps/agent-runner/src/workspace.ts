import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { AppConfig, logger } from '@nuage-agent/core';

/**
 * Ensures a repository is cloned locally and updated to the latest main branch.
 * Returns the absolute path of the repository workspace.
 */
export function ensureWorkspace(repo: string, config: AppConfig): string {
  // Repo is e.g. "k-wa-wa/workflow-sandbox" -> folder name is "workflow-sandbox"
  const repoFolder = repo.split('/').pop() || repo;
  const targetDir = path.resolve(config.workspacesDir, repoFolder);

  // Ensure parent workspaces dir exists
  if (!fs.existsSync(config.workspacesDir)) {
    fs.mkdirSync(config.workspacesDir, { recursive: true });
  }

  if (!fs.existsSync(targetDir)) {
    logger.info(`Cloning repository ${repo} to ${targetDir}...`, 'workspace');
    try {
      execSync(`gh repo clone "${repo}" "${targetDir}"`, { stdio: 'inherit' });
      logger.success(`Repository ${repo} cloned successfully.`, 'workspace');
    } catch (error) {
      logger.error(`Failed to clone repository ${repo}`, 'workspace', error);
      throw error;
    }
  } else {
    logger.info(`Updating repository ${repo} in ${targetDir}...`, 'workspace');
    try {
      // Pull latest main branch to be in sync
      execSync(`git checkout main || git checkout master`, { cwd: targetDir, stdio: 'ignore' });
      execSync(`git pull`, { cwd: targetDir, stdio: 'ignore' });
      logger.success(`Repository ${repo} updated.`, 'workspace');
    } catch (error) {
      logger.warn(`Failed to update/pull latest on ${repo}. Will proceed with current state.`, 'workspace');
    }
  }

  return targetDir;
}

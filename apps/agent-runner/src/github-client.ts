import { exec } from 'child_process';
import { GitHubIssue, GitHubComment, GitHubPullRequest, logger } from '@nuage-agent/core';

function execCommand(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        logger.error(`gh command error: ${stderr}`, 'github-client');
        reject(error);
      } else {
        resolve(stdout);
      }
    });
  });
}

export async function getIssuesWithLabel(repo: string, label: string): Promise<GitHubIssue[]> {
  try {
    const cmd = `gh issue list --repo "${repo}" --label "${label}" --json number,title,body,state,labels,createdAt,updatedAt`;
    const output = await execCommand(cmd);
    const parsed = JSON.parse(output) as any[];
    return parsed.map(item => ({
      number: item.number,
      title: item.title,
      body: item.body,
      state: item.state.toLowerCase() as 'open' | 'closed',
      labels: item.labels.map((l: any) => l.name),
      user: '', // gh issue list doesn't return user by default, not needed for pipeline check
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
  } catch (error) {
    logger.error(`Failed to get issues with label ${label} from ${repo}`, 'github-client', error);
    return [];
  }
}

export async function getIssueComments(repo: string, issueNumber: number): Promise<GitHubComment[]> {
  try {
    const cmd = `gh issue view ${issueNumber} --repo "${repo}" --json comments`;
    const output = await execCommand(cmd);
    const parsed = JSON.parse(output);
    const commentsList = parsed.comments || [];
    return commentsList.map((item: any) => ({
      id: item.id || 0,
      body: item.body || '',
      user: item.author?.login || 'unknown',
      createdAt: item.createdAt || '',
    }));
  } catch (error) {
    logger.error(`Failed to get comments for issue #${issueNumber} from ${repo}`, 'github-client', error);
    return [];
  }
}

export async function updateIssueLabels(
  repo: string,
  issueNumber: number,
  addLabels: string[],
  removeLabels: string[]
): Promise<void> {
  try {
    let cmd = `gh issue edit ${issueNumber} --repo "${repo}"`;
    if (addLabels.length > 0) {
      cmd += ` ` + addLabels.map(l => `--add-label "${l}"`).join(' ');
    }
    if (removeLabels.length > 0) {
      cmd += ` ` + removeLabels.map(l => `--remove-label "${l}"`).join(' ');
    }
    await execCommand(cmd);
    logger.success(`Updated labels for issue #${issueNumber} in ${repo} (Added: [${addLabels.join(',')}], Removed: [${removeLabels.join(',')}])`, 'github-client');
  } catch (error) {
    logger.error(`Failed to update labels for issue #${issueNumber} in ${repo}`, 'github-client', error);
  }
}

export async function getPullRequestsWithLabel(repo: string, label: string): Promise<GitHubPullRequest[]> {
  try {
    const cmd = `gh pr list --repo "${repo}" --label "${label}" --json number,title,body,state,labels,headRefName,baseRefName,createdAt,updatedAt`;
    const output = await execCommand(cmd);
    const parsed = JSON.parse(output) as any[];
    return parsed.map(item => ({
      number: item.number,
      title: item.title,
      body: item.body,
      state: item.state.toLowerCase() as 'open' | 'closed',
      labels: item.labels.map((l: any) => l.name),
      branch: item.headRefName || '',
      baseBranch: item.baseRefName || '',
      merged: item.state.toLowerCase() === 'merged',
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    }));
  } catch (error) {
    logger.error(`Failed to get pull requests with label ${label} from ${repo}`, 'github-client', error);
    return [];
  }
}

export async function updatePullRequestLabels(
  repo: string,
  prNumber: number,
  addLabels: string[],
  removeLabels: string[]
): Promise<void> {
  try {
    let cmd = `gh pr edit ${prNumber} --repo "${repo}"`;
    if (addLabels.length > 0) {
      cmd += ` ` + addLabels.map(l => `--add-label "${l}"`).join(' ');
    }
    if (removeLabels.length > 0) {
      cmd += ` ` + removeLabels.map(l => `--remove-label "${l}"`).join(' ');
    }
    await execCommand(cmd);
    logger.success(`Updated labels for PR #${prNumber} in ${repo} (Added: [${addLabels.join(',')}], Removed: [${removeLabels.join(',')}])`, 'github-client');
  } catch (error) {
    logger.error(`Failed to update labels for PR #${prNumber} in ${repo}`, 'github-client', error);
  }
}

const PIPELINE_LABELS = [
  { name: 'agent:spec', color: 'fbca04', description: 'Specification phase' },
  { name: 'agent:dev', color: '1d76db', description: 'Development phase' },
  { name: 'agent:review', color: '0e8a16', description: 'Review phase' },
  { name: 'agent:qa', color: 'b60205', description: 'QA phase' },
  { name: 'agent:triage', color: 'd93f0b', description: 'Triage phase' },
  { name: 'agent:running', color: '5319e7', description: 'Currently running' }
];

export async function ensureLabelsExist(repo: string): Promise<void> {
  logger.info(`Checking and ensuring pipeline labels exist for repository: ${repo}`, 'github-client');
  for (const label of PIPELINE_LABELS) {
    try {
      const cmd = `gh label create "${label.name}" --repo "${repo}" --color "${label.color}" --description "${label.description}" --force`;
      await execCommand(cmd);
    } catch (error) {
      logger.error(`Failed to ensure label "${label.name}" exists in ${repo}`, 'github-client', error);
    }
  }
}


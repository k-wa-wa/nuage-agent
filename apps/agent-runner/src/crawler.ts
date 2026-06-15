import * as path from 'path';
import * as fs from 'fs';
import { 
  AppConfig, 
  logger, 
  runCommand 
} from '@nuage-agent/core';
import { agentsList, Agent, AgentContext } from '@nuage-agent/agents';
import { 
  getIssuesWithLabel, 
  getIssueComments, 
  updateIssueLabels,
  getPullRequestsWithLabel,
  updatePullRequestLabels
} from './github-client.js';
import { ensureWorkspace } from './workspace.js';

export class PipelineCrawler {
  private config: AppConfig;
  private isRunning = false;

  constructor(config: AppConfig) {
    this.config = {
      ...config,
      claudeCommand: config.claudeCommand.startsWith('~/')
        ? config.claudeCommand.replace('~', process.env.HOME || '')
        : config.claudeCommand
    };
  }

  /**
   * Reads the repository map markdown file directly from the repo-map directory.
   */
  private getRepoMapMd(repo: string): string {
    const repoFolder = repo.split('/').pop() || repo;
    const mdPath = path.join(this.config.repoMapDir, `${repoFolder}.md`);

    if (fs.existsSync(mdPath)) {
      logger.debug(`Loaded repo-map from ${mdPath}`, 'crawler');
      return fs.readFileSync(mdPath, 'utf-8');
    }

    logger.warn(`No repo-map markdown file found at ${mdPath}`, 'crawler');
    return `リポジトリ "${repo}" の構造マップ（ディレクトリ構成、技術スタック、規約など）は未定義です。一般的なTypeScriptプロジェクトとして対応してください。`;
  }

  /**
   * Performs one full crawl cycle across all repositories.
   */
  public async crawlCycle(): Promise<void> {
    if (this.isRunning) {
      logger.info('Previous crawl cycle still running. Skipping...', 'crawler');
      return;
    }

    this.isRunning = true;
    logger.info('Starting crawl cycle...', 'crawler');

    try {
      for (const repo of this.config.repositories) {
        logger.info(`Checking repository: ${repo}`, 'crawler');
        
        // Loop through each registered agent in the interface list
        for (const agent of agentsList) {
          logger.debug(`Running check for Agent: ${agent.id} (label: ${agent.label})`, 'crawler');

          if (agent.targetType === 'issue') {
            await this.processIssueAgent(repo, agent);
          } else {
            await this.processPRAgent(repo, agent);
          }
        }

        // Post-review check: If a PR is labeled 'agent:review' and both reviewers have approved,
        // elevate state to 'agent:qa'
        await this.postReviewCheck(repo);
      }
    } catch (error) {
      logger.error('Error during crawl cycle', 'crawler', error);
    } finally {
      this.isRunning = false;
      logger.info('Crawl cycle completed.', 'crawler');
    }
  }

  /**
   * Process an agent targeting Issues (SpecAgent, DevAgent)
   */
  private async processIssueAgent(repo: string, agent: Agent): Promise<void> {
    const issues = await getIssuesWithLabel(repo, agent.label);

    for (const issue of issues) {
      if (issue.labels.includes('agent:running')) continue;

      logger.info(`Found Issue #${issue.number} for Agent ${agent.id}: "${issue.title}"`, 'crawler');

      // Lock the issue
      await updateIssueLabels(repo, issue.number, ['agent:running'], []);

      try {
        const workspacePath = ensureWorkspace(repo, this.config);
        const repoMapMd = this.getRepoMapMd(repo);

        // SpecAgent needs issue comments context
        let commentsMarkdown = '';
        if (agent.id === 'spec') {
          const comments = await getIssueComments(repo, issue.number);
          commentsMarkdown = comments
            .map(c => `[${c.user} - ${c.createdAt}]: ${c.body}`)
            .join('\n\n');
        }

        const context: AgentContext = {
          repoName: repo,
          repoMapMd,
          issue,
          commentsMarkdown
        };

        const prompt = agent.buildPrompt(context);

        // Execute CLI
        await this.executeAgentCLI(agent, prompt, workspacePath);
      } catch (error) {
        logger.error(`Error executing Agent ${agent.id} on Issue #${issue.number}`, 'crawler', error);
      } finally {
        // Unlock the issue
        await updateIssueLabels(repo, issue.number, [], ['agent:running']);
      }
    }
  }

  /**
   * Process an agent targeting PRs (ReviewAgents, QAAgent)
   */
  private async processPRAgent(repo: string, agent: Agent): Promise<void> {
    const prs = await getPullRequestsWithLabel(repo, agent.label);

    for (const pr of prs) {
      if (pr.labels.includes('agent:running')) continue;

      logger.info(`Found PR #${pr.number} for Agent ${agent.id}: "${pr.title}"`, 'crawler');

      // Lock the PR
      await updatePullRequestLabels(repo, pr.number, ['agent:running'], []);

      try {
        const workspacePath = ensureWorkspace(repo, this.config);
        const repoMapMd = this.getRepoMapMd(repo);

        const context: AgentContext = {
          repoName: repo,
          repoMapMd,
          pr
        };

        const prompt = agent.buildPrompt(context);

        // Execute CLI
        await this.executeAgentCLI(agent, prompt, workspacePath);
      } catch (error) {
        logger.error(`Error executing Agent ${agent.id} on PR #${pr.number}`, 'crawler', error);
      } finally {
        // Unlock the PR
        await updatePullRequestLabels(repo, pr.number, [], ['agent:running']);
      }
    }
  }

  /**
   * Helper to invoke the correct LLM CLI
   */
  private async executeAgentCLI(agent: Agent, prompt: string, workspacePath: string): Promise<void> {
    const isClaude = agent.commandType === 'claude';
    const cmd = isClaude ? this.config.claudeCommand : this.config.geminiCommand;
    const flags = isClaude ? this.config.claudeFlags : this.config.geminiFlags;

    logger.info(`Invoking CLI (${agent.commandType}) for Agent: ${agent.id}...`, 'crawler');

    const runnerArgs = [
      ...flags,
      isClaude ? '-p' : '',
      `"${prompt.replace(/"/g, '\\"')}"`
    ].filter(arg => arg !== '');

    const result = await runCommand({
      cmd,
      args: runnerArgs,
      cwd: workspacePath
    });

    logger.debug(`Agent ${agent.id} CLI completed with exit code: ${result.code}`, 'crawler');
  }

  /**
   * Post-review validation: If the PR still has the agent:review label, and both reviewers
   * have approved the PR (meaning neither reviewer downgraded it back to agent:dev),
   * we elevate it to agent:qa.
   */
  private async postReviewCheck(repo: string): Promise<void> {
    const prs = await getPullRequestsWithLabel(repo, 'agent:review');

    for (const pr of prs) {
      if (pr.labels.includes('agent:running')) continue;

      // Elevate the PR to agent:qa.
      logger.info(`PR #${pr.number} has passed all review agents. Elevating to QA.`, 'crawler');
      await updatePullRequestLabels(repo, pr.number, ['agent:qa'], ['agent:review']);
    }
  }
}

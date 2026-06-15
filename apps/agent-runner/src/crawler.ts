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
  updatePullRequestLabels,
  getViewerLogin
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
        
        // Resolve 'agent:wait' locks if there are new user comments
        await this.handleWaitingIssues(repo);

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
      if (issue.labels.includes('agent:wait')) continue;

      logger.info(`Found Issue #${issue.number} for Agent ${agent.id}: "${issue.title}"`, 'crawler');

      // Lock the issue
      await updateIssueLabels(repo, issue.number, ['agent:running'], []);

      try {
        const workspacePath = ensureWorkspace(repo, this.config);
        const repoMapMd = this.getRepoMapMd(repo);

        let commentsMarkdown = '';
        if (agent.id === 'spec') {
          const comments = await getIssueComments(repo, issue.number);
          commentsMarkdown = comments
            .map((c: any) => `[${c.user} - ${c.createdAt}]: ${c.body}`)
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
      isClaude ? '-p' : ''
    ].filter(arg => arg !== '');

    const result = await runCommand({
      cmd,
      args: runnerArgs,
      cwd: workspacePath,
      stdin: prompt
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

      // Query PR review comments / statuses
      // For now, check if reviewers left approval comments (meaning no further actions)
      const comments = await getIssueComments(repo, pr.number);
      const botUser = await getViewerLogin();

      // Check if both general and semantic reviewers approved
      const hasGeneralPassed = comments.some(c => c.user === botUser && c.body.includes('[General Review Result: PASSED]'));
      const hasSemanticPassed = comments.some(c => c.user === botUser && c.body.includes('[Semantic Review Result: PASSED]'));

      if (hasGeneralPassed && hasSemanticPassed) {
        logger.info(`PR #${pr.number} passed all review checks. Elevating to QA phase.`, 'crawler');
        await updatePullRequestLabels(repo, pr.number, ['agent:qa'], ['agent:review']);
      }
    }
  }

  /**
   * @what 'agent:wait' (保留中) ラベルが付いているIssueにおいて、新着コメントが自分以外のユーザー（または別Bot）から投稿されたかを検知し、ラベルを自動解除します。
   * @why ユーザーがコメントで返答した際に、手動でラベルを剥がす手間を省き、自動的にエージェント実行サイクルを再開させるため。
   */
  private async handleWaitingIssues(repo: string): Promise<void> {
    const waitingIssues = await getIssuesWithLabel(repo, 'agent:wait');
    if (waitingIssues.length === 0) return;

    const currentBotUser = await getViewerLogin();

    for (const issue of waitingIssues) {
      const comments = await getIssueComments(repo, issue.number);
      if (comments.length > 0) {
        const latestComment = comments[comments.length - 1];
        // If someone else (user or another bot) commented, remove the wait label to resume pipeline
        if (latestComment.user !== currentBotUser) {
          logger.info(`Detected new comment from user/other-bot on Issue #${issue.number}. Removing 'agent:wait' label.`, 'crawler');
          await updateIssueLabels(repo, issue.number, [], ['agent:wait']);
        }
      }
    }
  }
}

import { test, expect } from 'bun:test';
import type { AgentContext } from '../index.js';
import { SpecAgent, DevAgent, ReviewGeneralAgent, QAAgent, QAGeneratorAgent } from '../index.js';

test('SpecAgent compiles prompt with correct metadata', () => {
  const agent = new SpecAgent();
  const context: AgentContext = {
    repoName: 'pechka',
    repoMapMd: '## Repo Map details',
    issue: {
      number: 123,
      title: 'Add signup page',
      body: 'We need a React signup page.',
      state: 'open',
      labels: ['agent:spec'],
      user: 'alice',
      createdAt: '',
      updatedAt: '',
    },
  };

  const prompt = agent.buildPrompt(context);

  expect(prompt).toMatch(/仕様定義エージェント/);
  expect(prompt).toMatch(/pechka/);
  expect(prompt).toMatch(/Issue #123/);
  expect(prompt).toMatch(/Add signup page/);
  expect(prompt).toMatch(/## Repo Map details/);
  expect(prompt).toMatch(/gh issue view 123 --comments/);
  expect(prompt).toMatch(/gh issue edit 123/);
  expect(prompt).toMatch(/gh issue create/);
});

test('DevAgent (issue) compiles prompt with correct metadata', () => {
  const agent = new DevAgent('issue');
  const context: AgentContext = {
    repoName: 'nuage-cluster',
    repoMapMd: '## Database Rules',
    issue: {
      number: 456,
      title: 'Create Prisma schema',
      body: 'Add User model to Prisma.',
      state: 'open',
      labels: ['agent:dev'],
      user: 'bob',
      createdAt: '',
      updatedAt: '',
    },
  };

  const prompt = agent.buildPrompt(context);

  expect(prompt).toMatch(/開発エージェント/);
  expect(prompt).toMatch(/nuage-cluster/);
  expect(prompt).toMatch(/Issue #456/);
  expect(prompt).toMatch(/gh issue view 456/);
  expect(prompt).toMatch(/feature\/issue-456/);
});

test('ReviewGeneralAgent compiles prompt with correct metadata', () => {
  const agent = new ReviewGeneralAgent();
  const context: AgentContext = {
    repoName: 'nuage-cluster',
    repoMapMd: '## Code Rules',
    pr: {
      number: 789,
      title: 'Fix memory leak',
      body: 'Release resources on clean up.',
      state: 'open',
      labels: ['agent:review-general'],
      branch: 'fix/mem-leak',
      baseBranch: 'main',
      merged: false,
      createdAt: '',
      updatedAt: '',
    },
  };

  const prompt = agent.buildPrompt(context);

  expect(prompt).toMatch(/一般コードレビューエージェント/);
  expect(prompt).toMatch(/nuage-cluster/);
  expect(prompt).toMatch(/Pull Request #789/);
  expect(prompt).toMatch(/N\+1クエリ/);
});

test('QAAgent compiles prompt with correct metadata (manual merge default)', () => {
  const agent = new QAAgent();
  const context: AgentContext = {
    repoName: 'nuage-cluster',
    repoMapMd: '## QA Rules',
    pr: {
      number: 999,
      title: 'Integrate Stripe API',
      body: 'Stripe webhook and checkout flow.',
      state: 'open',
      labels: ['agent:qa'],
      branch: 'feature/stripe',
      baseBranch: 'main',
      merged: false,
      createdAt: '',
      updatedAt: '',
    },
  };

  const prompt = agent.buildPrompt(context);

  expect(prompt).toMatch(/QAエージェント/);
  expect(prompt).toMatch(/nuage-cluster/);
  expect(prompt).toMatch(/Pull Request #999/);
  expect(prompt).toMatch(/gh pr checkout 999/);
  expect(prompt).toMatch(/gh issue edit 999 --remove-label "agent:qa"/);
  expect(prompt).toMatch(/手動でのマージを求める/);
});

test('QAAgent compiles prompt with correct metadata and auto-merge instructions', () => {
  const agent = new QAAgent();
  const context: AgentContext = {
    repoName: 'nuage-cluster',
    repoMapMd: '## QA Rules',
    pr: {
      number: 999,
      title: 'Integrate Stripe API',
      body: 'Stripe webhook and checkout flow.',
      state: 'open',
      labels: ['agent:qa'],
      branch: 'feature/stripe',
      baseBranch: 'main',
      merged: false,
      createdAt: '',
      updatedAt: '',
    },
    autoMerge: true,
  };

  const prompt = agent.buildPrompt(context);

  expect(prompt).toMatch(/QAエージェント/);
  expect(prompt).toMatch(/nuage-cluster/);
  expect(prompt).toMatch(/Pull Request #999/);
  expect(prompt).toMatch(/gh pr checkout 999/);
  expect(prompt).toMatch(/gh pr merge 999 --merge --delete-branch/);
  expect(prompt).toMatch(/自動マージを実行します/);
});

test('DevAgent (pr) compiles prompt with correct metadata', () => {
  const agent = new DevAgent('pr');
  const context: AgentContext = {
    repoName: 'nuage-cluster',
    repoMapMd: '## Dev Rules',
    pr: {
      number: 888,
      title: 'Fix issue with tests',
      body: 'Rename test dir.',
      state: 'open',
      labels: ['agent:dev'],
      branch: 'feature/issue-2',
      baseBranch: 'main',
      merged: false,
      createdAt: '',
      updatedAt: '',
    },
  };

  const prompt = agent.buildPrompt(context);

  expect(prompt).toMatch(/PR修正担当/);
  expect(prompt).toMatch(/nuage-cluster/);
  expect(prompt).toMatch(/Pull Request #888/);
  expect(prompt).toMatch(/gh pr checkout 888/);
  expect(prompt).toMatch(
    /gh issue edit 888 --add-label "agent:review-general" --remove-label "agent:dev"/,
  );
});

test('QAGeneratorAgent compiles prompt with correct metadata', () => {
  const agent = new QAGeneratorAgent('[QA-Improve]');
  const context: AgentContext = {
    repoName: 'pechka',
    repoMapMd: '## Test Framework Rules',
  };

  const prompt = agent.buildPrompt(context);

  expect(prompt).toMatch(/QA改善・品質向上エージェント/);
  expect(prompt).toMatch(/pechka/);
  expect(prompt).toMatch(/## Test Framework Rules/);
  expect(prompt).toMatch(/\[QA-Improve\]/);
  expect(prompt).toMatch(/gh issue create/);
  expect(prompt).toMatch(/agent:spec/);
});

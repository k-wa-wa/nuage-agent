import { test } from 'node:test';
import * as assert from 'node:assert';
import type { AgentContext } from '../index.js';
import {
  SpecAgent,
  DevAgent,
  DevPRAgent,
  ReviewGeneralAgent,
  QAAgent,
  QAGeneratorAgent,
} from '../index.js';

void test('SpecAgent compiles prompt with correct metadata', () => {
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

  assert.match(prompt, /仕様定義エージェント/);
  assert.match(prompt, /pechka/);
  assert.match(prompt, /Issue #123/);
  assert.match(prompt, /Add signup page/);
  assert.match(prompt, /## Repo Map details/);
  assert.match(prompt, /gh issue view 123 --comments/);
  assert.match(prompt, /gh issue edit 123/);
  assert.match(prompt, /gh issue create/);
});

void test('DevAgent compiles prompt with correct metadata', () => {
  const agent = new DevAgent();
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

  assert.match(prompt, /開発エージェント/);
  assert.match(prompt, /nuage-cluster/);
  assert.match(prompt, /Issue #456/);
  assert.match(prompt, /gh issue view 456/);
  assert.match(prompt, /feature\/issue-456/);
});

void test('ReviewGeneralAgent compiles prompt with correct metadata', () => {
  const agent = new ReviewGeneralAgent();
  const context: AgentContext = {
    repoName: 'nuage-cluster',
    repoMapMd: '## Code Rules',
    pr: {
      number: 789,
      title: 'Fix memory leak',
      body: 'Release resources on clean up.',
      state: 'open',
      labels: ['agent:review'],
      branch: 'fix/mem-leak',
      baseBranch: 'main',
      merged: false,
      createdAt: '',
      updatedAt: '',
    },
  };

  const prompt = agent.buildPrompt(context);

  assert.match(prompt, /一般コードレビューエージェント/);
  assert.match(prompt, /nuage-cluster/);
  assert.match(prompt, /Pull Request #789/);
  assert.match(prompt, /N\+1クエリ/);
});

void test('QAAgent compiles prompt with correct metadata (manual merge default)', () => {
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

  assert.match(prompt, /QAエージェント/);
  assert.match(prompt, /nuage-cluster/);
  assert.match(prompt, /Pull Request #999/);
  assert.match(prompt, /gh pr checkout 999/);
  assert.match(prompt, /gh issue edit 999 --remove-label "agent:qa"/);
  assert.match(prompt, /手動でのマージを求める/);
});

void test('QAAgent compiles prompt with correct metadata and auto-merge instructions', () => {
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

  assert.match(prompt, /QAエージェント/);
  assert.match(prompt, /nuage-cluster/);
  assert.match(prompt, /Pull Request #999/);
  assert.match(prompt, /gh pr checkout 999/);
  assert.match(prompt, /gh pr merge 999 --merge --delete-branch/);
  assert.match(prompt, /自動マージを実行します/);
});

void test('DevPRAgent compiles prompt with correct metadata', () => {
  const agent = new DevPRAgent();
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

  assert.match(prompt, /PR修正担当/);
  assert.match(prompt, /nuage-cluster/);
  assert.match(prompt, /Pull Request #888/);
  assert.match(prompt, /gh pr checkout 888/);
  assert.match(prompt, /gh issue edit 888 --add-label "agent:review" --remove-label "agent:dev"/);
});

void test('QAGeneratorAgent compiles prompt with correct metadata', () => {
  const agent = new QAGeneratorAgent('[QA-Improve]');
  const context: AgentContext = {
    repoName: 'pechka',
    repoMapMd: '## Test Framework Rules',
  };

  const prompt = agent.buildPrompt(context);

  assert.match(prompt, /QA改善・品質向上エージェント/);
  assert.match(prompt, /pechka/);
  assert.match(prompt, /## Test Framework Rules/);
  assert.match(prompt, /\[QA-Improve\]/);
  assert.match(prompt, /gh issue create/);
  assert.match(prompt, /agent:spec/);
});

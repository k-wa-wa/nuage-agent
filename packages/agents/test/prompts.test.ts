import { test } from 'node:test';
import * as assert from 'node:assert';
import { 
  SpecAgent, 
  DevAgent, 
  ReviewGeneralAgent,
  AgentContext
} from '../src/index.js';

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
      updatedAt: ''
    },
    commentsMarkdown: 'User: Yes, with email/password.'
  };

  const prompt = agent.buildPrompt(context);

  assert.match(prompt, /仕様定義エージェント/);
  assert.match(prompt, /pechka/);
  assert.match(prompt, /Issue #123/);
  assert.match(prompt, /Add signup page/);
  assert.match(prompt, /We need a React signup page\./);
  assert.match(prompt, /## Repo Map details/);
  assert.match(prompt, /gh issue edit 123/);
});

test('DevAgent compiles prompt with correct metadata', () => {
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
      updatedAt: ''
    }
  };

  const prompt = agent.buildPrompt(context);

  assert.match(prompt, /開発エージェント/);
  assert.match(prompt, /nuage-cluster/);
  assert.match(prompt, /Issue #456/);
  assert.match(prompt, /Add User model to Prisma\./);
  assert.match(prompt, /feature\/issue-456/);
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
      labels: ['agent:review'],
      branch: 'fix/mem-leak',
      baseBranch: 'main',
      merged: false,
      createdAt: '',
      updatedAt: ''
    }
  };

  const prompt = agent.buildPrompt(context);

  assert.match(prompt, /一般レビューエージェント/);
  assert.match(prompt, /nuage-cluster/);
  assert.match(prompt, /Pull Request #789/);
  assert.match(prompt, /N\+1クエリ/);
});

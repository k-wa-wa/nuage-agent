export * from './types.js';
export { SpecAgent } from './spec/agent.js';
export { DevAgent } from './dev/agent.js';
export { ReviewGeneralAgent } from './review-general/agent.js';
export { ReviewSemanticAgent } from './review-semantic/agent.js';
export { QAAgent } from './qa/agent.js';

import { SpecAgent } from './spec/agent.js';
import { DevAgent } from './dev/agent.js';
import { ReviewGeneralAgent } from './review-general/agent.js';
import { ReviewSemanticAgent } from './review-semantic/agent.js';
import { QAAgent } from './qa/agent.js';
import type { Agent } from './types.js';

export const agentsList: Agent[] = [
  new SpecAgent(),
  new DevAgent(),
  new ReviewGeneralAgent(),
  new ReviewSemanticAgent(),
  new QAAgent(),
];

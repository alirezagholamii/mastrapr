import { Agent } from '@mastra/core/agent';
import { noopLogger } from '@mastra/core/logger';
import type { AgentModel } from './index.js';
import { sharedInstructions } from './security.js';

export function createQualityAgent(model: AgentModel) {
  const agent = new Agent({
    id: 'quality-inspector',
    name: 'Code Quality Inspector',
    model,
    instructions: `${sharedInstructions}\nFocus on correctness, edge cases, resource leaks, concurrency,
error handling, and significant maintainability issues with a concrete impact. Do not repeat security
findings or suggest cosmetic refactors, extra documentation, or tests without a demonstrated bug.`,
  });
  agent.__setLogger(noopLogger);
  return agent;
}

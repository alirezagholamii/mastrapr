import type { Agent } from '@mastra/core/agent';
import { agentReportSchema } from '../types/index.js';
import type { ReviewAgent } from '../types/index.js';
import type { Config } from '../utils/config.js';
import { createSecurityAgent } from './security.js';
import { createQualityAgent } from './quality.js';

export type AgentModel = ConstructorParameters<typeof Agent>[0]['model'];

export function parseAgentReport(text: string) {
  const json = text.trim().replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  return agentReportSchema.parse(JSON.parse(json));
}

/** Load only the selected provider. The original Ollama adapter uses AI SDK v1. */
export async function createReviewAgents(config: Config): Promise<{ security: ReviewAgent; quality: ReviewAgent }> {
  let model: AgentModel;
  if (config.LLM_PROVIDER === 'ollama') {
    const { createOllama } = await import('ollama-ai-provider');
    model = createOllama({ baseURL: config.OLLAMA_BASE_URL })(config.OLLAMA_MODEL);
  } else {
    const { createOpenAI } = await import('@ai-sdk/openai');
    model = createOpenAI({ apiKey: config.OPENAI_API_KEY! })(config.OPENAI_MODEL);
  }
  function wrap(agent: Pick<Agent, 'generate' | 'generateLegacy'>): ReviewAgent {
    return {
      async review(prompt, signal) {
        const response = config.LLM_PROVIDER === 'ollama'
          ? await agent.generateLegacy(prompt, {
            abortSignal: signal, maxSteps: 1, maxRetries: 0, maxTokens: config.MAX_OUTPUT_TOKENS,
          })
          : await agent.generate(prompt, {
            abortSignal: signal, maxSteps: 1,
            modelSettings: { maxOutputTokens: config.MAX_OUTPUT_TOKENS, maxRetries: 0 },
          });
        return parseAgentReport(response.text);
      },
    };
  }
  return { security: wrap(createSecurityAgent(model)), quality: wrap(createQualityAgent(model)) };
}

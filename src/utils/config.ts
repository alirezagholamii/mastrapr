import { z } from 'zod';

const integer = (value: number, min: number, max: number) =>
  z.coerce.number().int().min(min).max(max).default(value);

const configSchema = z.object({
  HOST: z.string().default('0.0.0.0'),
  PORT: integer(3000, 1, 65535),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  GITHUB_WEBHOOK_SECRET: z.string().min(32),
  GITHUB_TOKEN: z.string().trim().min(1),
  GITHUB_REPOSITORIES: z.string().transform(value => value.split(',').map(v => v.trim().toLowerCase()))
    .pipe(z.array(z.string().regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/)).min(1)),
  LLM_PROVIDER: z.enum(['ollama', 'openai']).default('ollama'),
  OLLAMA_BASE_URL: z.string().url().default('http://127.0.0.1:11434/api'),
  OLLAMA_MODEL: z.string().trim().min(1).default('qwen2.5-coder:7b'),
  OPENAI_MODEL: z.string().trim().min(1).default('gpt-4.1-mini'),
  OPENAI_API_KEY: z.string().optional(),
  MAX_DIFF_CHARS: integer(60000, 1000, 200000),
  MAX_FILE_CHARS: integer(12000, 100, 50000),
  MAX_FILES: integer(40, 1, 200),
  MAX_QUEUE_SIZE: integer(10, 1, 100),
  REVIEW_TIMEOUT_MS: integer(180000, 1000, 900000),
  MAX_OUTPUT_TOKENS: integer(3000, 256, 8000),
}).superRefine((config, ctx) => {
  if (config.LLM_PROVIDER === 'openai' && !config.OPENAI_API_KEY?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['OPENAI_API_KEY'], message: 'Required for OpenAI' });
  }
});

export type Config = z.infer<typeof configSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = configSchema.safeParse(env);
  if (!result.success) {
    // Never include environment values or raw Zod errors in logs.
    throw new Error(`Invalid configuration: ${[...new Set(result.error.issues.map(i => i.path.join('.')))].join(', ')}`);
  }
  return result.data;
}

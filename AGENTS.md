# AGENTS.md — Development Blueprint for `mastra-pr-reviewer`

You are an expert TypeScript engineer building `mastra-pr-reviewer`: a lightweight, self-hosted, multi-agent GitHub Pull Request reviewer powered by [Mastra](https://mastra.ai/) and Fastify.

---

## 🎯 Core Goals & Technical Constraints

1. **Language & Environment:** Pure TypeScript on Node.js (v20+). No Python or external runtime dependencies.
2. **Frameworks:** `@mastra/core` for multi-agent workflows, `fastify` for HTTP webhooks, `@octokit/rest` for GitHub API calls, `zod` for schemas.
3. **Provider Agnostic:** Must seamlessly support both **Ollama** (via `ollama-ai-provider`) and **Cloud LLMs** (via `@ai-sdk/openai`, `@ai-sdk/anthropic`, etc.) toggled via `.env`.
4. **Low Memory Footprint:** The webhook server and Mastra workflow must consume < 150 MB RAM at idle to comfortably run on a $4/month Linux VPS.
5. **Security:** Every incoming GitHub webhook request MUST be verified using HMAC SHA-256 signatures (`X-Hub-Signature-256`).

---

## 📁 Repository Structure

Adhere strictly to this directory layout when creating files:

```text
mastra-pr-reviewer/
├── .github/
│   └── workflows/
│       └── ci.yml
├── src/
│   ├── agents/
│   │   ├── index.ts           # Central agent exports & provider loader
│   │   ├── security.ts        # Security Auditor Agent
│   │   └── quality.ts         # Code Quality Inspector Agent
│   ├── workflows/
│   │   └── prReview.ts        # Mastra Workflow (Fetch -> Analyze -> Post)
│   ├── utils/
│   │   ├── config.ts          # Zod-validated environment variables
│   │   ├── github.ts          # Octokit client & PR comment helpers
│   │   ├── diff.ts            # Git diff parser & truncation logic
│   │   └── verifySignature.ts # GitHub HMAC Webhook signature validator
│   ├── types/
│   │   └── index.ts           # Shared TypeScript interfaces
│   └── server.ts              # Fastify webhook listener entry point
├── .env.example
├── Dockerfile
├── docker-compose.yml
├── tsconfig.json
├── package.json
└── README.md
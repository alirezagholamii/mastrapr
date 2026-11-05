# mastra-pr-reviewer

A self-hosted GitHub PR reviewer built with TypeScript, Fastify, and Mastra. Comment `/review` on an open, non-draft PR to run a Security Auditor and Code Quality Inspector. They focus on security vulnerabilities, bugs, and significant maintainability issues. Results appear in one summary comment that is updated on later runs.

Uses Ollama by default, or OpenAI through `.env`. No database, clone, shell tools, source execution, Mastra Studio, or external queue is required. GitHub diffs are the only source context.

See [Architecture](docs/architecture.md) for component responsibilities, the review lifecycle, security boundaries, and reliability constraints.

## Requirements

- Node.js **22.13+** (required by the pinned Mastra release; Node 24 is also supported).
- A GitHub personal access token and repository webhook secret.
- An existing Ollama server with a pulled model, or an OpenAI API key.

## Run locally

```sh
npm install
cp .env.example .env
# Edit .env: set token, webhook secret, and repository allowlist.
npm run build
npm start
```

For development use `npm run dev`. `.env` is loaded by Node's native environment loader; real environment variables take precedence. Docker reads environment variables directly. Never commit `.env`.

Generate a webhook secret with `openssl rand -hex 32`. Use the same value in `.env` and GitHub. `GITHUB_REPOSITORIES` is a required comma-separated allowlist, for example `acme/api,acme/web`.

## GitHub setup

1. Create a fine-grained PAT limited to the repositories to review. Grant **Metadata: read**, **Contents: read**, **Pull requests: read**, and **Issues: read and write**. The token's account must have the repository access needed to check collaborator permission levels. Organization approval or SSO authorization may be required. A dedicated bot account makes the comment author clearer.
2. In each repository, open **Settings → Webhooks → Add webhook**. Set the payload URL to `https://your-host/webhook`, content type to `application/json`, and enter your webhook secret.
3. Select **Let me select individual events → Issue comments**. No pull-request event subscription is needed. Check the signed ping delivery succeeds.
4. A collaborator with **write, maintain, or admin** permission comments `/review` as the entire comment on a PR. Edited comments, regular issues, bot comments, drafts, and closed PRs are skipped. Recheck permissions if requests are queued but no comment appears; a permission API error fails closed.

The command is deliberately restricted to writers so public commenters cannot spend your model budget. The token's account posts the summary. Only comments with the reviewer's marker **and that account's user ID** are updated. Changing the token account creates a new summary comment.

Put a TLS reverse proxy in front of the server for public webhooks. Keep `/health` available for liveness checks. The application verifies HMAC SHA-256 against the exact request bytes before decoding JSON; do not configure a proxy to rewrite webhook bodies.

## Model configuration

Ollama:

```dotenv
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434/api
OLLAMA_MODEL=qwen2.5-coder:7b
```

Pull that model on your Ollama server before the first review (`ollama pull qwen2.5-coder:7b`). Model choice is configurable; a model that reliably emits JSON works best. The original `ollama-ai-provider` uses an AI SDK v1 adapter, so this path uses Mastra's `generateLegacy()`. OpenAI uses the current `generate()` API. Both paths validate model output with Zod; invalid output is a failed check, never a clean review.

OpenAI:

```dotenv
LLM_PROVIDER=openai
OPENAI_API_KEY=your-key
OPENAI_MODEL=gpt-4.1-mini
```

Switching providers requires a restart. The OpenAI path sends the PR title and selected diff to OpenAI. The Ollama path sends them to your configured Ollama endpoint. Neither agent has tools or access to the GitHub token. Source content is treated as untrusted input, and generated HTML/mentions are escaped in summaries. Model judgments still need human verification.

## Docker

```sh
cp .env.example .env
# Set credentials and repositories.
docker compose up --build -d
docker compose logs -f reviewer
```

Compose binds only `127.0.0.1:3000`; route your TLS proxy there. The container runs as an unprivileged user with a read-only filesystem. `HOST` and `PORT` are fixed to `0.0.0.0:3000` inside Compose.

The build emits JavaScript with `tsconfig.build.json`, without full type checking, dependency type resolution, or declaration generation. This keeps compilation memory lower on a small VPS. CI runs the full `npm run typecheck` separately before testing, then builds with a 128 MB Node heap cap to guard against compilation-memory regressions. Total process memory exceeds heap memory; this is separate from the idle runtime memory target. For local source changes, run the typecheck on your development machine before deploying.

If an older copy fails at `RUN npm run build` with `JavaScript heap out of memory`, copy the updated `package.json`, `tsconfig.build.json`, and `Dockerfile` to the VPS, then rebuild:

```sh
docker compose up --build -d
docker compose logs --tail=50 reviewer
curl http://127.0.0.1:3000/health
```

A healthy response is `{"status":"ok"}`. This confirms the application is running locally on the VPS. GitHub still needs a public HTTPS webhook URL forwarded to this service; the Docker build itself does not need a domain or an inbound port 443.

Compose defaults Ollama to `http://host.docker.internal:11434/api`. Set `OLLAMA_BASE_URL_DOCKER` in `.env` to use a remote host or another container. Host Ollama must listen on a network interface reachable from the container; protect that interface from public access. Ollama itself is not started by this Compose file.

## Resource limits and reliability

| Variable | Default | Purpose |
| --- | --- | --- |
| `MAX_DIFF_CHARS` | 60000 | Total annotated diff characters per agent |
| `MAX_FILE_CHARS` | 12000 | Annotated patch characters per file |
| `MAX_FILES` | 40 | Maximum included files |
| `MAX_QUEUE_SIZE` | 10 | Active plus queued PRs |
| `REVIEW_TIMEOUT_MS` | 180000 | Job deadline, including GitHub and model calls |
| `MAX_OUTPUT_TOKENS` | 3000 | Maximum output per agent |
| `LOG_LEVEL` | info | Structured server log level |

One PR is reviewed at a time, and its agents run sequentially. Up to three times `MAX_FILES` candidates are fetched, rounded to 100-file API pages and capped at 600 candidates. Lockfiles, common generated/binary assets, and unavailable patches are omitted. Oversized patches are clipped at whole lines. Summaries count omitted and truncated files; files outside the fetched window are also counted as omitted. This is a bounded review, not a complete repository audit.

PR head and base SHAs are checked after fetching and before posting. If either changes, the result is discarded; request `/review` again. A final GitHub update can still race a new push, so the summary always names its reviewed commit. A failed agent produces an explicitly incomplete summary, including when both agents fail. A PR with no reviewable patches is skipped and logged.

Webhooks receive `202` immediately. Queue saturation returns `503` with `Retry-After`. Delivery IDs are retained in a bounded in-memory cache for up to 24 hours, and repeated requests for an active/queued PR are coalesced. Queue and deduplication state are lost on restart. Run a **single replica** to prevent concurrent comment creation; this version has no durable jobs or cross-process locking.

After an API failure, timeout, restart, or full queue, comment `/review` again or manually redeliver the webhook in GitHub. GitHub does not automatically retry failed deliveries. Inspect logs for the delivery ID and outcome. Errors are sanitized to keep tokens and source code out of logs; detailed upstream error payloads are intentionally suppressed. SIGTERM/SIGINT abort active work and discard queued work.

The application targets **under 150 MB RSS at idle**, using lazy workflow/provider imports and no storage or observability service. The target needs measurement on your deployment, including idle after a review; it is not a guaranteed memory ceiling. Compose allows 256 MB for import/review spikes. Ollama model memory is separate and generally far exceeds a tiny VPS's capacity: run it on another machine, or select OpenAI. The reviewer itself requires only Node.js at runtime.

## Development and validation

```sh
npm run typecheck
npm test
npm run build
```

Tests use Node's test runner, injected GitHub/model fakes, Fastify injection, and real Mastra workflow execution. GitHub client tests exercise Octokit with a mocked HTTP transport, including permissions, pagination, cancellation, and summary ownership. Queue tests cover sequential execution, deadlines with a fake clock, and redelivery after failure. They make no network or model calls. `npm run typecheck` validates application and test code; production builds exclude test files. CI runs on Node 22 and 24. Commit `package-lock.json` and use `npm ci` for repeatable dependency installation.

Measure the running server with your platform's process monitor (`ps -o rss= -p <pid>` reports KiB on Linux/macOS), or `docker stats --no-stream`, both after startup and after a review. A health response verifies HTTP liveness only; it does not check token permissions or model availability.

API references: [Mastra workflows](https://mastra.ai/docs/workflows/overview), [Agent generation](https://mastra.ai/reference/agents/generate), [legacy generation](https://mastra.ai/reference/agents/generateLegacy), [Ollama adapter](https://github.com/sgomez/ollama-ai-provider), [GitHub webhook validation](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries).

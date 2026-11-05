# Troubleshooting

Use this guide to find the failing layer before changing settings. Plain-text command files are linked throughout for easier copying.

## Current deployment

| Component | Address or name |
| --- | --- |
| Public health endpoint | `https://review.example.com/health` |
| GitHub webhook | `https://review.example.com/webhook` |
| Reviewer container | `mastrapr-reviewer-1` |
| Reviewer Docker network | `mastrapr_default` |
| Separate Caddy project | `/root/caddy` |
| Ollama on the VPS | `172.17.0.1:11434` |
| Ollama endpoint from reviewer | `http://host.docker.internal:11434/api` |

These names describe the deployment investigated so far. Inspect the actual configuration if you rename containers, change networks, or move Ollama.

The public health endpoint and Docker-to-Ollama connectivity have both been confirmed working. OpenAI reviews worked after token permissions were corrected. Ollama review completion remains unconfirmed; the latest logs show slow prompt processing followed by failed requests.

## Choose the symptom

| Symptom | Start here |
| --- | --- |
| `no configuration file provided: not found` | Working directory |
| Docker build reports JavaScript heap out of memory | Build memory |
| Local health works, public HTTPS fails | HTTPS and Caddy |
| Caddy returns `502 Bad Gateway` | Docker networks |
| Webhook receives `401` | Webhook signature |
| `/review` has no result | Trigger filtering and reviewer logs |
| `github-comment-write` with HTTP `403` | GitHub token permissions |
| Both checks fail with Ollama | Ollama connectivity, then model generation |
| `EHOSTUNREACH` | Host listener and firewall |
| Model loading cancelled after three minutes | Review deadline |
| Prompt processing is slow or requests fail near five minutes | Slow inference and HTTP timeouts |

## Working directory

`docker compose` needs a Compose file in the current directory or one supplied with `-f`.

Run reviewer management commands in the reviewer project directory, where `docker-compose.yml` and `.env` are located. Run separate Caddy management commands in `/root/caddy`.

Container commands work from any directory:

```sh
docker logs --since 10m --tail 100 mastrapr-reviewer-1
docker ps --format 'table {{.Names}}\t{{.Ports}}'
```

For a multiline Node diagnostic, use `docker exec -i mastrapr-reviewer-1` instead of `docker compose exec -T reviewer` when outside the reviewer directory.

## Rebuild, recreate, or neither?

| Change | Action |
| --- | --- |
| Application source, dependencies, or Dockerfile | Rebuild and recreate reviewer |
| `.env` model, endpoint, provider, or timeout | Recreate reviewer; no build needed |
| Existing GitHub token's permissions | Retry with a new `/review` comment; no container change normally needed |
| Replacement token value in `.env` | Recreate reviewer |
| Ollama systemd environment | Reload systemd and restart Ollama |
| Live firewall allow rule | Retest connectivity; no reviewer restart needed |
| Caddy Compose network membership | Run `docker compose up -d` in `/root/caddy` |

Rebuild from the reviewer directory:

```sh
docker compose up -d --build reviewer
```

Apply `.env` changes from the reviewer directory:

```sh
docker compose up -d --force-recreate reviewer
```

A plain container restart does not reload Compose's `env_file` values. Recreating or rebuilding also cancels active reviews.

## Build memory

**Symptom:** `FATAL ERROR: Reached heap limit` while running `tsc` during the Docker build.

Use the updated `package.json`, `tsconfig.build.json`, and Dockerfile. The build emits JavaScript without loading the dependency type graph or generating declarations. Full type checking remains a separate CI check.

The revised build passes locally with a 128 MB Node heap cap. Total process memory is higher than heap memory, and this does not establish the application's idle-memory usage.

Increasing Compose's service `mem_limit` does not change the compiler's build-time heap limit.

## HTTPS and Caddy

Check health on the VPS:

```sh
curl http://127.0.0.1:3000/health
curl https://review.example.com/health
```

Both should return `{"status":"ok"}`. Health confirms HTTP liveness, not GitHub permissions or model generation.

If local health works but HTTPS fails, inspect DNS, inbound TCP ports 80/443, and Caddy logs. If HTTPS returns `502`, check whether Caddy can reach `reviewer:3000` on a shared Docker network.

For this separate `/root/caddy` deployment, use the [standalone Caddy Compose file](caddy-standalone-compose.yml) as `/root/caddy/docker-compose.yml`. It attaches Caddy to the existing `mastrapr_default` network. The reviewer must be running before this external network can be used.

Plain-text instructions: [HTTPS setup](https-setup.txt), [Caddy network fix](caddy-network-fix.txt).

## Webhook signature and triggers

A `401` webhook response means signature verification failed. Ensure the GitHub webhook secret matches `GITHUB_WEBHOOK_SECRET`, the content type is `application/json`, and the proxy preserves the request body. Recreate the reviewer if its `.env` secret changed.

If an accepted webhook produces no review, check:

- The event subscription is **Issue comments**.
- The command is a **new** comment containing only `/review`, allowing surrounding whitespace.
- The repository is listed in `GITHUB_REPOSITORIES`.
- The PR is open and not a draft.
- The commenter has write, maintain, or admin permission.
- Another request for the same PR is not already active or queued.

Skipped jobs are logged. A `202` response means the webhook was accepted, ignored, or deduplicated; inspect its response status and the job outcome. It does not prove a completed review.

## GitHub token permissions

**Observed symptom:** `stage: github-comment-write`, `httpStatus: 403`.

The app reached summary posting, but GitHub rejected the write. For a fine-grained personal access token, verify repository selection and grant **Issues: Read and write**. GitHub also accepts **Pull requests: write** for this comment operation. Keep the other permissions documented in the [README](../README.md).

If write access is already configured, check organization approval/SSO requirements and API rate limiting. A `403` alone cannot distinguish those causes.

If you edit permissions on the same token, retry with a new comment. If you replace the token, update `.env` and recreate the container.

Plain-text instructions: [Review troubleshooting](review-troubleshooting.txt).

## Ollama connectivity

Test server reachability separately from model loading and generation. An HTTP `200` from `/api/tags` proves reachability and lists installed models; it does not prove a model can generate a review.

On the VPS host:

```sh
ss -lntp 'sport = :11434'
curl --connect-timeout 5 http://172.17.0.1:11434/api/tags
```

In this deployment, Ollama was changed from `127.0.0.1:11434` to the Docker host address `172.17.0.1:11434`. The original loopback-only listener was inaccessible through the Docker host gateway. Host CLI commands now also need the changed address:

```sh
OLLAMA_HOST=172.17.0.1:11434 ollama ps
```

The reviewer's `.env` uses:

```dotenv
LLM_PROVIDER=ollama
OLLAMA_MODEL=qwen2.5-coder:1.5b
OLLAMA_BASE_URL_DOCKER=http://host.docker.internal:11434/api
```

Compose maps `OLLAMA_BASE_URL_DOCKER` to the application's `OLLAMA_BASE_URL`. Changing only `OLLAMA_BASE_URL` in `.env` does not override that Compose setting.

Plain-text commands, including an in-container connectivity test: [Connectivity checks](ollama-connectivity.txt), [host listener configuration](ollama-vps-fix.txt).

### EHOSTUNREACH and the firewall

In the investigated deployment, UFW was inactive, but iptables had a terminal `REJECT ... icmp-host-prohibited` rule. It blocked container traffic to Ollama even after the host listener worked.

The fix inserts an allow rule before the reject rule, restricted to the reviewer Docker subnet, destination `172.17.0.1`, and TCP port `11434`. Do not disable the firewall or open this port to all sources.

Use [ollama-firewall-fix.txt](ollama-firewall-fix.txt), which discovers the subnet and includes a reversal command. Its live rule is **not persistent across reboot/firewall reload**. Add the confirmed rule to the system that manages the host's firewall; persistence has not yet been configured. Avoid saving/restoring all Docker-generated rules blindly.

If connectivity breaks again after a reboot, recheck this rule. If the network changed, inspect its new subnet before applying a rule.

Additional checks: [Network diagnostics](ollama-network-diagnostics.txt).

## Model loading, slow inference, and timeouts

### Cancellation after three minutes

An Ollama `499` after `3m0s`, with `client connection closed` and `context canceled`, is consistent with the reviewer's default `180000` ms deadline cancelling model loading.

Set `REVIEW_TIMEOUT_MS=900000` in `.env` and recreate the reviewer if a longer deadline is appropriate. This allows 15 minutes for the **whole job**, including both sequential agents; it is not 15 minutes per agent. Increasing it does not make inference faster.

### Slow prompt processing

The observed log reported 512 tokens in 103.23 seconds, about 4.96 prompt tokens/second. At that rate, a 2,939-token prompt takes roughly ten minutes before response generation. Two such checks can exceed the 15-minute job limit. Cache reuse and resource contention can change the actual timing.

For a small diagnostic review, try:

```dotenv
REVIEW_TIMEOUT_MS=900000
MAX_DIFF_CHARS=2000
MAX_FILE_CHARS=1000
```

These limits reduce review coverage. Check omitted/truncated counts in the summary. Completion and model output validity are still not guaranteed.

### Requests failing near five minutes

The old Ollama adapter path used Node's default response-header timeout while waiting for a complete JSON response. The updated client has a dedicated Ollama transport with header/body inactivity timeouts disabled; the job's abort signal remains the absolute deadline. Deploying this source/dependency change requires a rebuild.

The repeated Ollama HTTP `500` entries near five minutes are compatible with a timeout-related failure, but those server logs alone do not establish its cause. New diagnostics can distinguish `UND_ERR_HEADERS_TIMEOUT` from an HTTP status returned by Ollama.

### Resource checks

Run on the VPS host:

```sh
free -h
swapon --show
nproc
uptime
systemctl show ollama -p MemoryMax -p MemoryHigh -p CPUQuotaPerSecUSec
```

Ollama uses host resources independently of the reviewer's container memory limit. Slow processing alone does not prove an out-of-memory condition. Check available memory, swap activity, CPU load, service limits, and kernel logs before changing more settings.

Avoid starting repeated reviews or preloads while one is active.

Plain-text instructions: [Loading and resource checks](ollama-loading.txt), [slow VPS deployment steps](ollama-slow-vps.txt), [monitoring](monitor-ollama.txt).

## Interpreting reviewer diagnostics

| Diagnostic | Meaning / next check |
| --- | --- |
| `github-permissions` | Requester permission lookup failed |
| `github-pr` / `github-diff` | PR or patch retrieval failed |
| `github-recheck` | PR state/revision check failed |
| `github-identity` | Token account lookup failed |
| `github-comments` | Existing summary lookup failed |
| `github-comment-write` | Summary create/update failed |
| `agents-init` | Provider or agent construction failed |
| `agent-security` / `agent-quality` | Generation or output validation failed |
| `ECONNREFUSED` | Check endpoint address and listener |
| `EHOSTUNREACH` / `ENETUNREACH` | Check host routing and firewall rules |
| `ENOTFOUND` / `EAI_AGAIN` | Check DNS and hostname |
| `UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT` | HTTP transport timeout |
| `INVALID_JSON` / `INVALID_OUTPUT` | Model response failed parsing or schema validation |
| `timedOut: true` | Job cancellation signal fired; may be deadline or shutdown |

`status: posted` means a summary was posted; it may still be incomplete. Read any `Review completed with failed checks` warning and its diagnostics array. If both checks failed, there is no code assessment—an empty finding list is not a clean review.

When sharing logs, include the delivery ID, operation stage, status/error code, and nearby timestamps. Do not share `.env` or tokens. Application diagnostics are sanitized; inspect dependency-generated logs before sharing them.

## References

- [GitHub webhook setup](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)
- [GitHub comment permissions](https://docs.github.com/en/rest/issues/comments#create-an-issue-comment)
- [GitHub API troubleshooting](https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api)
- [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/)
- [Caddy HTTPS](https://caddyserver.com/docs/quick-starts/https)
- [Ollama configuration and loading](https://docs.ollama.com/faq)
- [Ollama troubleshooting](https://docs.ollama.com/troubleshooting)
- [Undici client timeouts](https://github.com/nodejs/undici/blob/main/docs/docs/api/Client.md)

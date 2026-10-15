# stackwright

A coder for a gitops repository. You post a change request; stackwright lets a coding agent implement it on a branch in its own clone of your repository, runs your checks, fast-forwards the main branch and pushes it to the remote that deploys. Built for stacks where the push is the deploy: a post-receive hook, [stacktender](https://github.com/handijk/stacktender), Flux, Argo, Komodo.

stackwright runs Claude Code through the Agent SDK. It is not an Anthropic product; see [Credentials](#credentials) for how it signs in.

## A task, step by step

1. **Branch.** The private clone is reset to the deploy remote's main branch, and a branch `stackwright/<slug>-<task id>` is made from it. One task runs at a time; the rest queue.
2. **Agent.** The agent gets the brief (your `description` and `context`), the repository's own instructions (`CLAUDE.md` or `AGENTS.md`, read by Claude Code as usual) and your `prompt` file. It reads, edits and commits on the branch. It is told never to merge, push or leave the clone. Permission prompts are off inside the container: the clone is the sandbox, and there is no Docker socket.
3. **Checks.** With commits on the branch, stackwright runs every `checks` entry whose `paths` the commits touch (tests, a typecheck), itself, after the agent has stopped. A failed check is a failed attempt.
4. **Merge and push.** The branch is replayed on the remote's current main, main is fast-forwarded to it and pushed to the deploy remote, then to the mirror remote if there is one. The branch stays in the clone.
5. **Result.** The task record (`status`, `commits`, `summary` or `error`, `cost`) is readable over HTTP and delivered to your webhook and/or an MQTT topic.

**Attempts.** A task gets `attempts` tries of `attemptTimeoutMinutes` each. A failed check, a timed-out attempt, a rebase that conflicts or a deploy that failed ends the attempt; the next one resumes the agent's session with the failure in front of it. A push that merely lost a race with another push is replayed on the new main without the agent. After the last attempt the task fails and the state says `action_required`.

**A deploy that fails.** A post-receive hook cannot refuse a push, so its verdict comes as text: when `deployDonePattern` is set and the push output does not match it, the deploy failed. stackwright then puts main back to the commit before the merge and feeds the output to the next attempt. If someone else pushed in between, it leaves main alone and stops with `action_required`. Without the pattern, git's verdict is the verdict.

**Statuses:** `queued`, `running`, `completed`, `no-changes` (the agent decided nothing had to change, or said in `summary` what blocks it), `failed`.

## API

|                                 |                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /tasks`                   | `{"description": "...", "context": "...", "notify": "always" \| "on_failure" \| "never", "webhook": "https://..."}` → `202 {"task_id", "branch", "status": "queued"}`. `description` is the task. `context` is what the caller knows and the agent should too (a log excerpt, a finding). `notify` decides whether the result is delivered (default `always`). `webhook` overrides the configured one for this task. `503` while stackwright has no credential. |
| `GET /tasks`                    | the recent tasks, newest first                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `GET /tasks/<id>`               | one task                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `GET /health`                   | `{"ok", "version", "queued", "running", "auth": "api-key" \| "subscription" \| "none", "ready"}`                                                                                                                                                                                                                                                                                                                                                                |
| `POST /auth/setup-token/start`  | only with `api.setupToken: true`: starts `claude setup-token` and answers `{"url", "valid_minutes": 10}`; see [Credentials](#credentials)                                                                                                                                                                                                                                                                                                                       |
| `POST /auth/setup-token/finish` | `{"code": "..."}` or `{"callback_url": "..."}` from Claude's page → `{"ok", "token", "test"}`. The token is in use from then on and is yours to keep; stackwright does not store it.                                                                                                                                                                                                                                                                            |

The API has no users: bind it to localhost (the default) or put it behind your proxy. `api.token` makes it require `Authorization: Bearer <token>`.

A delivered result:

```json
{
  "task_id": "1760281200000-k3j9x2",
  "branch": "stackwright/add-a-guard-1760281200000-k3j9x2",
  "status": "completed",
  "commits": ["a1b2c3d..."],
  "summary": "Landed on the first attempt.\nBranch: ...\nCommits:\n  a1b2c3d... Add a guard to the toilet light\n\nI added ...",
  "error": null,
  "cost": {
    "usd": 0.84,
    "models": {
      "claude-opus-5-5": {"input": 1203, "output": 2210, "cache_read": 310550, "cache_write": 41200, "usd": 0.84}
    }
  },
  "description": "...",
  "notify": "always",
  "finished_at": "2026-10-12T15:00:00.000Z"
}
```

`cost` is Claude Code's own estimate at list prices, added up over the attempts; a subscription run reports it too, as what the task would have cost on an API key. An attempt the timeout aborted contributes nothing. `null` until the agent has answered once.

The state on MQTT (retained): `{"status": "idle" | "running" | "action_required", "message", "tasks": [...], "auth", "at"}`.

## Configuration

`stackwright.yaml`, mounted at `/config/stackwright.yaml` (or wherever `STACKWRIGHT_CONFIG` says):

```yaml
repository:
  deploy: han@nas:/home/han/gitops-home # the remote whose push deploys; the clone is made from it
  mirror: git@github.com:handijk/home-ops.git # optional, pushed after the deploy remote, best effort
  main: master
  deployDonePattern: '\[deploy\] done:' # the push output must match it, or the deploy failed; unset: git decides
  pushRetries: 4 # replays of a push that lost a race
checks:
  - paths: [statebridge/]
    command: cd statebridge && bun install --frozen-lockfile && bun test test/
checkTimeoutMinutes: 15
agent:
  runtime: claude-code # the only one in this version; see Roadmap
  model: claude-opus-5-5
  auth: subscription # or api-key; unset: Claude Code's own precedence (the API key wins)
  attempts: 3
  attemptTimeoutMinutes: 30
  prompt: prompt.md # appended to stackwright's system prompt: what the repository is, your rules (relative to this file)
  mcp: mcp.json # MCP servers the agent gets (logs, metrics, your own tools), Claude Code's format
  git: {name: stackwright, email: stackwright@localhost} # the identity of the commits
notify:
  webhook: http://localhost:3000/coder/result # every result, as JSON; retried twice
  mqtt:
    url: mqtt://localhost:1883
    resultsTopic: stackwright/results
    stateTopic: stackwright/state
api:
  listen: 127.0.0.1:8091 # unset: STACKWRIGHT_LISTEN, which the image sets to 0.0.0.0:8091
  token: null
  setupToken: false
```

The system prompt is stackwright's: the rules of the workspace, the checks, how to stop and say what blocks you. Everything about _your_ repository and _your_ rules goes in `prompt.md` and in the repository's `CLAUDE.md`. Tools the agent needs beyond files and a shell come as MCP servers in `mcp.json`, in Claude Code's format (`{"mcpServers": {"loki": {"type": "sse", "url": "http://localhost:8092/sse"}}}`).

The checks run inside the container, so the toolchain has to be there. The image has git, ssh, Node and Claude Code; for anything else build on it:

```dockerfile
FROM ghcr.io/handijk/stackwright:0.1.2
COPY --from=oven/bun:1.3.11 /usr/local/bin/bun /usr/local/bin/bun
```

## Running it

```yaml
services:
  stackwright:
    image: ghcr.io/handijk/stackwright:0.1.2
    restart: unless-stopped
    ports: ['127.0.0.1:8091:8091']
    volumes:
      - ./stackwright.yaml:/config/stackwright.yaml:ro
      - ./stackwright-prompt.md:/config/prompt.md:ro
      - ./stackwright-workspace:/workspace # the private clone, made on first start
      - ./stackwright-data:/data # task records
      - ~/.ssh:/home/node/.ssh:ro # the key the deploy and mirror remotes accept
    env_file: secrets/stackwright.env # ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
```

Without a container: `npx stackwright` on a Linux machine with git and ssh, with `STACKWRIGHT_CONFIG` pointing at the yaml (default `/config/stackwright.yaml`), `STACKWRIGHT_WORKSPACE` and `STACKWRIGHT_DATA` for the clone and the task records (`/workspace`, `/data`) and `STACKWRIGHT_LISTEN` (`127.0.0.1:8091`). The package brings Claude Code with it, through the Agent SDK; the setup-token login wants `script` from util-linux, which is the Linux part.

The container runs as uid 1000; the mounted directories are chowned on first start. Task records survive a restart: a task whose branch landed while stackwright was away is completed, one caught mid-flight is failed, and both are reported.

## Credentials

stackwright signs in exactly as Claude Code does, with one of two variables in its environment, and has no login of its own:

- **`ANTHROPIC_API_KEY`**: a key from the [Claude Console](https://platform.claude.com). This is the way Anthropic documents for products built on the Agent SDK. Max and Team plans include [monthly API credits](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-and-team-plans) that cover Agent SDK use through a linked Console organization, and that stop instead of billing when they are used up.
- **`CLAUDE_CODE_OAUTH_TOKEN`**: a long-lived token you make on your own Pro, Max, Team or Enterprise plan with [`claude setup-token`](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token), the same way the [Claude Code GitHub Action](https://code.claude.com/docs/en/github-actions) takes one. Tasks then draw on your plan's usage limits. The command can be run from the image: `docker run --rm -it --entrypoint claude ghcr.io/handijk/stackwright:0.1.2 setup-token`.

`agent.auth` pins one of the two: the other is dropped from the environment at start, and a run Claude Code reports as billed to the other is aborted. Without a credential stackwright takes no tasks (`503`, state `action_required`). Without the pin, Claude Code's own precedence applies and the log says what a task ran on.

`api.setupToken: true` drives the same `claude setup-token` over the API, for an operator who cannot open a terminal on the host (a home automation that logs in from a chat, say): `start` answers with the login URL, you log in on Anthropic's page, `finish` takes the code that page shows and answers with the token, which is in use from then on. stackwright keeps nothing: put the token in your secrets store and in the container's environment for the next start. It is off by default and belongs on localhost only.

Following Anthropic's [legal and compliance](https://code.claude.com/docs/en/legal-and-compliance) page: stackwright runs the unmodified Claude Code that the Agent SDK bundles; the sign-in is Anthropic's own flow, run by you; stackwright never collects, stores or forwards a credential; the usage is yours, on your own plan or key, and nobody runs stackwright on someone else's plan. Anthropic's usage limits assume ordinary individual use, which a serial queue of change requests to one repository is. What a subscription covers for the Agent SDK changed several times in 2026; the pages linked above are the ones that count.

## What it is not

- No pull requests, no review UI, no approval step. Your checks and your deploy's hook are the gate, and your watchdog is the rollback. If you want review, point `deploy` at a branch your review flow watches.
- Not a chat agent. It reports results; something else talks to people.
- No web UI.

## Roadmap

- `agent.runtime: managed-agents`: Anthropic's [Managed Agents](https://platform.claude.com/docs/en/managed-agents/overview) with a self-hosted sandbox worker, for API billing without a container that holds the agent loop.
- `POST /tasks/<id>/cancel`.
- arm64 image.

## Where it comes from

The coder of [gitops-home](https://github.com/handijk/home-ops), which has taken change requests from a chat agent and deployed them with a push since April 2026, generalized. The house keeps its own parts outside: the subscription login run from chat, the prompt about the house, the MCP servers for logs and state.

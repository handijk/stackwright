# Changelog

## 0.1.0 (unreleased)

### Added

- The loop of a task: a branch from the deploy remote's main, the agent (Claude Code through the Agent SDK),
  the checks on the files the commits touch, the replay on the current main, the fast-forward and the push
  that deploys, the mirror push; attempts that resume the agent's session with the failure in front of it;
  the rollback of a deploy the remote reported as failed, unless someone else pushed in between.
- The HTTP API: `POST /tasks`, `GET /tasks`, `GET /tasks/<id>`, `GET /health`, an optional bearer token.
- Results over a webhook (retried) and MQTT; the state retained on MQTT.
- Credentials as Claude Code reads them (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`), `agent.auth` to pin
  one, and Claude Code's own `setup-token` login over HTTP when `api.setupToken` is on.
- Recovery after a restart: a task whose branch landed is completed, one caught mid-flight is failed.

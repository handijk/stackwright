/**
 * The configuration: `stackwright.yaml`, merged over these defaults. Every key is documented in the README.
 */

export const DEFAULTS = {
    repository: {
        /** The remote whose push deploys; the private clone is made from it. */
        deploy: null,
        /** Pushed after the deploy remote, best effort. */
        mirror: null,
        main: 'main',
        /**
         * A regular expression the output of the push must match for the deploy to count as done: a post-receive
         * hook cannot refuse a push, so its verdict comes as text. Unset: git's verdict is the verdict.
         */
        deployDonePattern: null,
        /** A push that lost a race with another push is replayed on the new main this many times. */
        pushRetries: 4,
    },
    /** [{paths: ['dir/'], command: '...'}]: run in the clone after the agent, when a commit touches one of the paths. */
    checks: [],
    checkTimeoutMinutes: 15,
    agent: {
        /** 'claude-code' is the only runtime in this version. */
        runtime: 'claude-code',
        model: 'claude-opus-5-5',
        /** 'subscription' (CLAUDE_CODE_OAUTH_TOKEN) or 'api-key' (ANTHROPIC_API_KEY); unset: Claude Code's own precedence. */
        auth: null,
        attempts: 3,
        attemptTimeoutMinutes: 30,
        /** A file whose text is appended to the system prompt: what the repository is, your rules. */
        prompt: null,
        /** A JSON file with the MCP servers the agent gets, in Claude Code's format. */
        mcp: null,
        /** The identity of the commits. */
        git: {name: 'stackwright', email: 'stackwright@localhost'},
    },
    notify: {
        /** Every result is POSTed here as JSON; a task may name its own. */
        webhook: null,
        /** {url, username, password, resultsTopic, stateTopic}; unset: no MQTT. */
        mqtt: null,
    },
    api: {
        /** host:port; unset: STACKWRIGHT_LISTEN, then 127.0.0.1:8091. */
        listen: null,
        /** When set, every request needs `Authorization: Bearer <token>`. */
        token: null,
        /** Expose Claude Code's own long-lived login (`claude setup-token`) over HTTP; see the README before turning it on. */
        setupToken: false,
    },
};

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function merge(base, over) {
    const out = {...base};
    for (const [k, v] of Object.entries(over ?? {})) out[k] = isPlain(v) && isPlain(base?.[k]) ? merge(base[k], v) : v;
    return out;
}

/** The configuration as read: the file's values over the defaults. */
export function mergeConfig(fromFile) {
    const cfg = merge(DEFAULTS, fromFile ?? {});
    if (cfg.notify.mqtt)
        cfg.notify.mqtt = {resultsTopic: 'stackwright/results', stateTopic: 'stackwright/state', ...cfg.notify.mqtt};
    return cfg;
}

/** What keeps a configuration from running, as sentences; none when it can. */
export function problems(cfg) {
    const out = [];
    if (!cfg.repository?.deploy) out.push('repository.deploy is required: the remote whose push deploys');
    if (![AUTH.subscription, AUTH.apiKey, null, undefined].includes(cfg.agent?.auth))
        out.push(`agent.auth must be "subscription" or "api-key", not ${JSON.stringify(cfg.agent?.auth)}`);
    if (cfg.agent?.runtime !== 'claude-code') out.push('agent.runtime: only "claude-code" exists in this version');
    if (!(Number(cfg.agent?.attempts) >= 1)) out.push('agent.attempts must be at least 1');
    if (!(Number(cfg.agent?.attemptTimeoutMinutes) > 0)) out.push('agent.attemptTimeoutMinutes must be positive');
    if (!Array.isArray(cfg.checks)) out.push('checks must be a list');
    else
        cfg.checks.forEach((c, i) => {
            if (!c || typeof c.command !== 'string' || !c.command.trim()) out.push(`checks[${i}] needs a command`);
            if (c && c.paths !== undefined && !Array.isArray(c.paths)) out.push(`checks[${i}].paths must be a list`);
        });
    if (cfg.repository?.deployDonePattern) {
        try {
            new RegExp(cfg.repository.deployDonePattern);
        } catch (err) {
            out.push(`repository.deployDonePattern is not a regular expression: ${err.message}`);
        }
    }
    if (cfg.notify?.mqtt && !cfg.notify.mqtt.url) out.push('notify.mqtt.url is required when notify.mqtt is set');
    return out;
}

export const AUTH = {subscription: 'subscription', apiKey: 'api-key'};

/** 'host:port' → {host, port}. */
export function parseListen(listen) {
    const m = /^(.*):(\d+)$/.exec(String(listen ?? ''));
    if (!m) throw new Error(`api.listen must be host:port, not ${JSON.stringify(listen)}`);
    return {host: m[1] || '0.0.0.0', port: Number(m[2])};
}

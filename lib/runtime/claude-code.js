/**
 * The agent: Claude Code through the Agent SDK, in the clone, with the credential Claude Code reads from the
 * environment (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN). And, when the API exposes it, Claude Code's own
 * long-lived login: `claude setup-token` prints a URL, waits for the one-time code Claude's page shows after
 * the login, and answers with a token valid for a year. It wants a terminal, so it runs under `script`.
 */

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {AUTH} from '../../config.js';
import {run} from '../git.js';

const require = createRequire(import.meta.url);

/** The Claude Code binary the SDK bundles for this platform, or `claude` on the PATH. */
export function claudeBinary() {
    if (process.env.STACKWRIGHT_CLAUDE) return process.env.STACKWRIGHT_CLAUDE;
    const musl = process.platform === 'linux' && !process.report?.getReport?.()?.header?.glibcVersionRuntime;
    const base = `${process.platform}-${process.arch}`;
    for (const c of [`${base}${musl ? '-musl' : ''}`, base, `${base}-musl`]) {
        try {
            const bin = path.join(
                path.dirname(require.resolve(`@anthropic-ai/claude-agent-sdk-${c}/package.json`)),
                'claude',
            );
            if (fs.existsSync(bin)) return bin;
        } catch {
            // not installed for this platform
        }
    }
    return 'claude';
}

/** Which credential Claude Code picks from an environment: 'api-key', 'subscription' or 'none'. */
export function authFromEnv(env = process.env) {
    if (env.ANTHROPIC_API_KEY) return AUTH.apiKey;
    if (env.CLAUDE_CODE_OAUTH_TOKEN) return AUTH.subscription;
    return 'none';
}

/** Make the environment match the pin: the other credential is dropped, and said so. */
export function applyAuthPin(auth, env = process.env, log = () => {}) {
    if (auth === AUTH.subscription && env.ANTHROPIC_API_KEY) {
        delete env.ANTHROPIC_API_KEY;
        log('ANTHROPIC_API_KEY dropped from the environment: agent.auth is subscription');
    }
    if (auth === AUTH.apiKey && env.CLAUDE_CODE_OAUTH_TOKEN) {
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
        log('CLAUDE_CODE_OAUTH_TOKEN dropped from the environment: agent.auth is api-key');
    }
}

// What Claude Code reports as the source of the key when a run is billed to an API key.
const API_KEY_SOURCES = ['ANTHROPIC_API_KEY', 'apiKeyHelper', '/login managed key'];

// Terminal escapes out of what `script` captured: the control characters are the point.
/* eslint-disable no-control-regex */
const plain = (s) =>
    s
        .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
        .replace(/\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g, '')
        .replace(/\r/g, '\n');
/* eslint-enable no-control-regex */
const withoutSecrets = (s) => s.replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-…');

export class ClaudeCodeRuntime {
    /**
     * @param {object} a
     * @param {string} a.model
     * @param {string|null} [a.auth] the pin: 'subscription' | 'api-key' | null
     * @param {(msg: string) => void} [a.log]
     * @param {Function} [a.query] the SDK's query, for tests
     * @param {string} [a.binary] the Claude Code binary for setup-token and the test prompt
     */
    constructor({model, auth = null, log = () => {}, query = null, binary = null}) {
        this.model = model;
        this.auth = auth;
        this.log = log;
        this._query = query;
        this._binary = binary;
        this.flow = null;
    }

    get binary() {
        if (!this._binary) this._binary = claudeBinary();
        return this._binary;
    }

    /** The credential in the environment right now. */
    get authInUse() {
        return authFromEnv();
    }

    /** Tasks can run: the pinned credential is there, or any is. */
    get ready() {
        const a = authFromEnv();
        return this.auth ? a === this.auth : a !== 'none';
    }

    async query() {
        if (!this._query) ({query: this._query} = await import('@anthropic-ai/claude-agent-sdk'));
        return this._query;
    }

    /**
     * One run of the agent. Resolves with the session id (to resume), the last text, and the key source
     * Claude Code reported. Throws when a subscription-pinned run would be billed to an API key.
     */
    async run({prompt, cwd, systemPrompt, mcpServers = {}, resume = null, abortController, onEvent = () => {}}) {
        const query = await this.query();
        let sessionId = null;
        let text = '';
        let apiKeySource = null;
        let turns = 0;
        const options = {
            cwd,
            model: this.model,
            systemPrompt,
            permissionMode: 'bypassPermissions',
            mcpServers,
            abortController,
            ...(resume ? {resume} : {}),
        };
        for await (const msg of query({prompt, options})) {
            turns++;
            if (msg.type === 'system' && msg.subtype === 'init') {
                if (typeof msg.session_id === 'string') sessionId = msg.session_id;
                apiKeySource = msg.apiKeySource ?? 'unknown';
                onEvent({type: 'init', sessionId, apiKeySource, model: msg.model ?? this.model});
                if (this.auth === AUTH.subscription && API_KEY_SOURCES.includes(apiKeySource))
                    throw new Error(`refusing to run on an API key (${apiKeySource}): agent.auth is subscription`);
            } else if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
                for (const block of msg.message.content) {
                    if (block.type === 'text' && typeof block.text === 'string') {
                        text = block.text;
                        onEvent({type: 'text', text: block.text});
                    } else if (block.type === 'tool_use') onEvent({type: 'tool', name: block.name});
                }
            } else if (msg.type === 'result' && typeof msg.result === 'string') {
                text = msg.result;
                onEvent({type: 'result', text: msg.result});
            }
        }
        return {sessionId, text, apiKeySource, turns};
    }

    // --- Claude Code's own long-lived login, driven over the API ---

    endSetupToken() {
        if (!this.flow) return;
        clearTimeout(this.flow.timer);
        this.flow.child.kill('SIGKILL');
        this.flow = null;
    }

    lastLines() {
        return withoutSecrets(plain(this.flow?.output ?? ''))
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-4)
            .join(' | ')
            .slice(-400);
    }

    /** Wait until what the command printed satisfies `find`. */
    awaitOutput(find, ms, what) {
        const flow = this.flow;
        return new Promise((resolve, reject) => {
            const started = Date.now();
            const tick = setInterval(() => {
                const found = find(plain(flow.output));
                if (found !== null) {
                    clearInterval(tick);
                    resolve(found);
                    return;
                }
                if (flow.child.exitCode !== null || Date.now() - started > ms) {
                    clearInterval(tick);
                    reject(new Error(`${what}. Claude Code said: ${this.lastLines() || '(nothing)'}`));
                }
            }, 250);
        });
    }

    /** Start the login: the URL to open. One at a time; a new URL makes the earlier one useless. */
    async startSetupToken() {
        this.endSetupToken();
        const env = {...process.env, TERM: 'xterm'};
        delete env.CLAUDE_CODE_OAUTH_TOKEN;
        // A wide terminal, so that the URL is printed on one line.
        const child = spawn('script', ['-qfc', `stty cols 500 2>/dev/null; ${this.binary} setup-token`, '/dev/null'], {
            cwd: '/tmp',
            env,
        });
        const flow = {child, output: '', timer: setTimeout(() => this.endSetupToken(), 10 * 60 * 1000)};
        child.stdout?.on('data', (d) => (flow.output += d.toString()));
        child.stderr?.on('data', (d) => (flow.output += d.toString()));
        child.on('error', (err) => (flow.output += `\n${err.message}\n`));
        this.flow = flow;
        try {
            return await this.awaitOutput(
                (text) => {
                    const urls = text.match(/https:\/\/\S+oauth\/authorize\?\S+/g);
                    const url = urls?.[urls.length - 1];
                    return url && /[?&]state=/.test(url) ? url : null;
                },
                30_000,
                'Claude Code showed no login URL',
            );
        } catch (err) {
            this.endSetupToken();
            throw err;
        }
    }

    /** Finish the login with the code as Claude's page shows it ("code#state") or the callback URL carrying both. */
    async finishSetupToken(input) {
        const flow = this.flow;
        if (!flow || flow.child.exitCode !== null)
            throw new Error(
                'No login is in progress (a login URL is good for ten minutes and for one login). Get a new URL first.',
            );
        let code = String(input ?? '').trim();
        if (/^https?:\/\//.test(code)) {
            const url = new URL(code);
            const c = url.searchParams.get('code');
            const state = url.searchParams.get('state');
            if (!c) throw new Error('That URL carries no code.');
            code = state ? `${c}#${state}` : c;
        }
        const seen = plain(flow.output).length;
        flow.child.stdin?.write(code);
        await new Promise((r) => setTimeout(r, 300));
        flow.child.stdin?.write('\r');
        try {
            const answer = await this.awaitOutput(
                (text) => {
                    const token = /sk-ant-oat[0-9A-Za-z_-]{20,}/.exec(text)?.[0];
                    if (token) return token;
                    // It says so when the code is wrong or too old; no point in waiting out the minute.
                    return /invalid|expired|failed|error/i.test(text.slice(seen)) ? 'refused' : null;
                },
                60_000,
                'Claude Code gave no token',
            );
            if (answer === 'refused')
                throw new Error(`Claude did not accept the code. Claude Code said: ${this.lastLines()}`);
            return answer;
        } finally {
            this.endSetupToken();
        }
    }

    /** Use a token from now on, in this process. */
    useToken(token) {
        process.env.CLAUDE_CODE_OAUTH_TOKEN = token;
    }

    /** One prompt on the credential in use, with the model the tasks use: does it carry it? */
    async testPrompt() {
        try {
            const {stdout} = await run(this.binary, ['-p', 'Reply with the single word: ok', '--model', this.model], {
                cwd: '/tmp',
                timeoutMs: 90_000,
            });
            return `a test prompt on ${this.model} answered: ${stdout.trim().slice(0, 80)}`;
        } catch (err) {
            return `a test prompt on ${this.model} failed: ${withoutSecrets(String(err?.message ?? err)).slice(-300)}`;
        }
    }
}

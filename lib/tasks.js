/**
 * The tasks: a serial queue, the record of each on disk, and the loop of one task: the branch, the agent,
 * the checks, the landing on the deploy remote with its replays and its rollback, the result.
 */

import fs from 'node:fs';
import path from 'node:path';
import {applicable, runChecks} from './checks.js';
import {DEPLOY, MIRROR} from './git.js';
import {systemPrompt} from './prompt.js';

export const BRANCH_PREFIX = 'stackwright/';
export const NOTIFY = ['always', 'on_failure', 'never'];

export function slugify(text, maxLen = 40) {
    return (
        String(text)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-|-$/g, '')
            .slice(0, maxLen) || 'change'
    );
}

/** The cost of a task: its chains of sessions added up, dollars and tokens per model. */
export function sumCosts(costs) {
    const total = {usd: 0, models: {}};
    for (const c of costs) {
        total.usd += c.usd ?? 0;
        for (const [model, u] of Object.entries(c.models ?? {})) {
            const m = (total.models[model] ??= {input: 0, output: 0, cache_read: 0, cache_write: 0, usd: 0});
            for (const k of Object.keys(m)) m[k] += u[k] ?? 0;
        }
    }
    total.usd = Number(total.usd.toFixed(6));
    for (const m of Object.values(total.models)) m.usd = Number(m.usd.toFixed(6));
    return total;
}

const tail = (text, n = 40) =>
    String(text ?? '')
        .split('\n')
        .filter(Boolean)
        .slice(-n)
        .join('\n');

const fixIt =
    'Inspect the code you wrote and fix the specific issue above. Make another commit on the same branch; do not start over.';

export class Tasks {
    /**
     * @param {object} a
     * @param {object} a.cfg the merged configuration
     * @param {import('./git.js').Workspace} a.workspace
     * @param {object} a.runtime run({...}), authInUse, ready
     * @param {import('./notify.js').Notifier} a.notifier
     * @param {string} a.storePath the JSON file of the task records
     * @param {string} [a.prompt] appended to the system prompt
     * @param {object} [a.mcpServers]
     * @param {(msg: string) => void} [a.log]
     * @param {() => number} [a.now]
     */
    constructor({
        cfg,
        workspace,
        runtime,
        notifier,
        storePath,
        prompt = '',
        mcpServers = {},
        log = () => {},
        now = Date.now,
    }) {
        this.cfg = cfg;
        this.ws = workspace;
        this.runtime = runtime;
        this.notifier = notifier;
        this.storePath = storePath;
        this.extraPrompt = prompt;
        this.mcpServers = mcpServers;
        this.log = log;
        this.now = now;
        this.tasks = new Map();
        this.queue = [];
        this.current = null;
        /** A sticky escalation: the state stays action_required until the next task starts. */
        this.actionRequired = null;
        this.load();
    }

    get queued() {
        return this.queue.length;
    }

    get running() {
        return this.current !== null;
    }

    get notReadyMessage() {
        const pin = this.cfg.agent.auth;
        const what =
            pin === 'subscription'
                ? 'subscription login (CLAUDE_CODE_OAUTH_TOKEN)'
                : pin === 'api-key'
                  ? 'API key (ANTHROPIC_API_KEY)'
                  : 'credential (ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN)';
        return `stackwright has no ${what} and takes no tasks`;
    }

    load() {
        try {
            for (const t of JSON.parse(fs.readFileSync(this.storePath, 'utf-8'))) this.tasks.set(t.task_id, t);
        } catch (err) {
            if (err?.code !== 'ENOENT') this.log(`task records at ${this.storePath} not read: ${err.message}`);
        }
    }

    save() {
        try {
            fs.mkdirSync(path.dirname(this.storePath), {recursive: true});
            const tmp = `${this.storePath}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.list().slice(0, 1000), null, 2));
            fs.renameSync(tmp, this.storePath);
        } catch (err) {
            this.log(`task records not saved: ${err.message}`);
        }
    }

    /** Newest first. */
    list() {
        return [...this.tasks.values()].sort((a, b) => b.started_at - a.started_at);
    }

    get(id) {
        return this.tasks.get(id) ?? null;
    }

    /** Queue a task. Resolves with its record as queued; throws on a body that is not one. */
    submit({description, context, notify, webhook} = {}) {
        description = typeof description === 'string' ? description.trim() : '';
        if (!description) throw new Error('description required');
        if (notify !== undefined && !NOTIFY.includes(notify))
            throw new Error(`notify must be one of ${NOTIFY.join(', ')}`);
        if (webhook !== undefined && !/^https?:\/\//.test(String(webhook)))
            throw new Error('webhook must be an http(s) URL');
        const ts = this.now();
        const id = `${ts}-${Math.random().toString(36).slice(2, 8)}`;
        const task = {
            task_id: id,
            branch: `${BRANCH_PREFIX}${slugify(description)}-${id}`,
            description,
            ...(typeof context === 'string' ? {context} : {}),
            ...(notify ? {notify} : {}),
            ...(webhook ? {webhook} : {}),
            status: 'queued',
            started_at: ts,
        };
        this.tasks.set(id, task);
        this.save();
        this.queue.push(id);
        this.log(`queued ${id}: ${description.slice(0, 80)}`);
        this.publishState();
        const queued = {...task};
        this.pump();
        return queued;
    }

    pump() {
        if (this.current || this.queue.length === 0) return;
        const id = this.queue.shift();
        this.current = id;
        this.runTask(this.tasks.get(id))
            .catch((err) => this.log(`${id}: ${err.message}`))
            .finally(() => {
                this.current = null;
                this.pump();
            });
    }

    /** Resolves when nothing is queued or running. */
    async idle() {
        while (this.current || this.queue.length > 0) await new Promise((r) => setTimeout(r, 20));
    }

    /** The state as the retained document says it. */
    state() {
        const at = new Date(this.now()).toISOString();
        const auth = this.runtime.authInUse;
        if (this.actionRequired) return {status: 'action_required', message: this.actionRequired, auth, at};
        if (!this.runtime.ready) return {status: 'action_required', message: this.notReadyMessage, auth, at};
        const active = this.list().filter((t) => t.status === 'running' || t.status === 'queued');
        if (active.length === 0) return {status: 'idle', message: 'idle, no tasks in flight', auth, at};
        return {
            status: 'running',
            message: `${active.length} task(s) in flight: ${active.map((t) => t.branch).join(', ')}`,
            tasks: active.map((t) => t.task_id),
            auth,
            at,
        };
    }

    publishState() {
        this.notifier.state(this.state());
    }

    /**
     * After a restart: a task that was running and whose branch is on the remote's main landed (the
     * result was lost to the restart); one that was not, and one that was queued, failed.
     */
    async recover() {
        let fetched = false;
        for (const t of this.list()) {
            if (t.status !== 'running' && t.status !== 'queued') continue;
            if (t.status === 'running') {
                if (!fetched) {
                    fetched = true;
                    await this.ws.remoteMain();
                }
                if (await this.ws.isAncestor(t.branch, `${DEPLOY}/${this.cfg.repository.main}`)) {
                    t.status = 'completed';
                    t.summary =
                        t.summary ?? `Branch ${t.branch} landed; the result was lost to a restart of stackwright.`;
                    t.finished_at = this.now();
                    await this.notifier.result(t);
                    continue;
                }
            }
            t.status = 'failed';
            t.error = 'stackwright restarted while the task was in flight';
            t.finished_at = this.now();
            await this.notifier.result(t);
        }
        this.save();
    }

    async runTask(task) {
        const {attempts, attemptTimeoutMinutes} = this.cfg.agent;
        const main = this.cfg.repository.main;
        const ws = this.ws;
        task.status = 'running';
        this.actionRequired = null;
        this.save();
        this.publishState();
        let finished = false;
        const finish = async () => {
            if (finished) return;
            finished = true;
            task.finished_at = task.finished_at ?? this.now();
            this.save();
            if (task.cost) this.log(`${task.task_id} cost $${task.cost.usd.toFixed(2)} (Claude Code's estimate)`);
            await this.notifier.result(task);
            this.publishState();
        };
        const prompt = systemPrompt({cwd: ws.dir, main, checks: this.cfg.checks, extra: this.extraPrompt});
        const brief = task.context
            ? `${task.description}\n\n--- Context from the caller ---\n${task.context}`
            : task.description;

        try {
            await ws.startBranch(task.branch);
            this.log(`${task.task_id} on ${task.branch}`);
            let lastText = '';
            let lastFailure = null;
            let sessionId = null;
            let resumable = false;
            let commits = [];
            let succeededAt = 0;
            // A run's cost is cumulative over its session, so a resumed attempt's figure replaces the chain's.
            const chains = new Map(); // chain key → the latest cost of that chain of sessions
            const chainOf = new Map(); // session id → chain key

            for (let attempt = 1; attempt <= attempts; attempt++) {
                const before = await ws.head();
                const resume = lastFailure && resumable && sessionId ? sessionId : null;
                const text = !lastFailure
                    ? brief
                    : resume
                      ? `Your last attempt did not land:\n${lastFailure}\n\n${fixIt}`
                      : `${brief}\n\n--- The previous attempt did not land ---\n${lastFailure}\n\n${fixIt}`;
                resumable = false;
                this.log(`${task.task_id} attempt ${attempt}/${attempts}${resume ? ` (resuming ${resume})` : ''}`);

                const abortController = new AbortController();
                let timedOut = false;
                const timer = setTimeout(() => {
                    timedOut = true;
                    abortController.abort();
                }, attemptTimeoutMinutes * 60_000);
                try {
                    const result = await this.runtime.run({
                        prompt: text,
                        cwd: ws.dir,
                        systemPrompt: prompt,
                        mcpServers: this.mcpServers,
                        resume,
                        abortController,
                        onEvent: (e) => {
                            if (e.type === 'init')
                                this.log(
                                    `${task.task_id} runs on ${e.apiKeySource === 'none' || e.apiKeySource === 'oauth' ? 'the subscription login' : `API key (${e.apiKeySource})`}, model ${e.model}`,
                                );
                            else if (e.type === 'tool') this.log(`${task.task_id} tool ${e.name}`);
                            else if (e.text) this.log(`${task.task_id} agent: ${e.text.slice(0, 200)}`);
                        },
                    });
                    if (result?.sessionId) sessionId = result.sessionId;
                    if (result?.text) lastText = result.text;
                    if (result?.cost) {
                        const key = resume
                            ? (chainOf.get(resume) ?? resume)
                            : (result.sessionId ?? `attempt-${attempt}`);
                        if (result.sessionId) chainOf.set(result.sessionId, key);
                        chains.set(key, result.cost);
                        task.cost = sumCosts(chains.values());
                    }
                } catch (err) {
                    if (!timedOut) throw err;
                } finally {
                    clearTimeout(timer);
                }
                resumable = !timedOut;

                const after = await ws.head();
                const landed = after !== before;
                if (timedOut && !landed) {
                    this.log(
                        `${task.task_id} attempt ${attempt} timed out after ${attemptTimeoutMinutes} min without a commit`,
                    );
                    lastFailure = `Attempt ${attempt} exceeded the ${attemptTimeoutMinutes}-minute limit and was aborted. The previous reasoning may have been stuck in a loop; take a simpler, more direct approach this time.`;
                    continue;
                }
                const headRef = await ws.headRef();
                if (headRef !== `refs/heads/${task.branch}`) {
                    task.status = 'failed';
                    task.error = `the agent moved HEAD off the task branch (now ${headRef || 'detached'})`;
                    task.summary = [
                        `Branch ${task.branch} kept for inspection.`,
                        '',
                        'Last agent output:',
                        lastText || '(empty)',
                    ].join('\n');
                    return;
                }
                if (!landed) {
                    if (attempt === 1) {
                        task.status = 'no-changes';
                        task.summary = lastText || 'The agent made no changes.';
                        return;
                    }
                    task.status = 'failed';
                    task.error = `the agent did not commit a fix on attempt ${attempt}`;
                    task.summary = [
                        `Branch ${task.branch} kept for inspection.`,
                        '',
                        'Last failure that was fed back:',
                        lastFailure ?? '(none)',
                        '',
                        'Last agent output:',
                        lastText || '(empty)',
                    ].join('\n');
                    return;
                }

                commits = await ws.commitsSince(main);
                task.commits = commits.map((c) => c.sha);
                this.save();
                await ws.discardUncommitted();

                const due = applicable(this.cfg.checks, await ws.changedFiles(main));
                if (due.length > 0) {
                    const check = await runChecks(due, {
                        cwd: ws.dir,
                        timeoutMs: this.cfg.checkTimeoutMinutes * 60_000,
                        log: (m) => this.log(`${task.task_id} ${m}`),
                    });
                    if (!check.ok) {
                        lastFailure = `The check \`${check.failed.command}\` failed:\n${check.failed.output}`;
                        this.log(`${task.task_id} attempt ${attempt}: a check failed`);
                        continue;
                    }
                }

                const land = await this.land(task);
                if (land.commits) {
                    commits = land.commits;
                    task.commits = commits.map((c) => c.sha);
                    this.save();
                }
                if (land.rebaseConflict) {
                    lastFailure = [
                        `\`${main}\` moved while you worked, and your commits no longer apply on top of it: \`git rebase ${DEPLOY}/${main}\` hit conflicts.`,
                        `Run \`git rebase ${DEPLOY}/${main}\` on this branch yourself, resolve each conflict so that both the other change and yours are kept, and finish the rebase. Do not discard the other side.`,
                        '',
                        land.rebaseConflict,
                    ].join('\n');
                    this.log(`${task.task_id} attempt ${attempt}: the rebase conflicted`);
                    await ws.checkout(task.branch).catch(() => {});
                    continue;
                }
                if (land.deployFailure) {
                    const remote = await ws.remoteMain();
                    if (remote && remote !== land.preMergeSha && remote !== land.mergedSha) {
                        this.actionRequired = `Task ${task.branch}: the deploy failed and ${DEPLOY}/${main} moved meanwhile (expected ${land.preMergeSha.slice(0, 10)} or ${land.mergedSha.slice(0, 10)}, found ${remote.slice(0, 10)}); a person has to reconcile`;
                        task.status = 'failed';
                        task.error = `deploy failed; a concurrent push to ${DEPLOY}/${main} blocked the rollback`;
                        task.summary = [
                            `Branch ${task.branch} kept for inspection.`,
                            `${main} was NOT rewound: that would destroy the concurrent commit.`,
                            '',
                            'The deploy failure:',
                            land.deployFailure,
                        ].join('\n');
                        return;
                    }
                    if (remote === land.mergedSha) {
                        await ws.resetMainTo(land.preMergeSha);
                        const back = await ws.pushMain(DEPLOY, {force: true});
                        if (!back.ok) this.log(`${task.task_id} rollback push failed: ${tail(back.output, 5)}`);
                        else
                            this.log(
                                `${task.task_id} attempt ${attempt}: deploy failed; ${main} back at ${land.preMergeSha.slice(0, 10)}`,
                            );
                    } else {
                        await ws.resetMainTo(land.preMergeSha);
                        this.log(`${task.task_id} attempt ${attempt}: the push did not land`);
                    }
                    await ws.checkout(task.branch).catch(() => {});
                    lastFailure = `The deploy failed:\n${land.deployFailure}`;
                    continue;
                }

                task.status = 'completed';
                task.summary = [
                    attempt === 1 ? 'Landed on the first attempt.' : `Landed after ${attempt} attempts.`,
                    `Branch: ${task.branch}`,
                    'Commits:',
                    ...commits.map((c) => `  ${c.sha} ${c.subject}`),
                    ...(lastText ? ['', lastText] : []),
                ].join('\n');
                succeededAt = attempt;
                await finish();
                break;
            }

            if (succeededAt === 0) {
                task.status = 'failed';
                task.error = `not landed after ${attempts} attempts`;
                task.summary = [
                    `Branch ${task.branch} kept for inspection.`,
                    '',
                    'Last failure:',
                    lastFailure ?? '(unknown)',
                    '',
                    'Last agent output:',
                    lastText || '(empty)',
                ].join('\n');
                this.actionRequired = `Task ${task.branch} failed after ${attempts} attempts; a person has to look`;
                return;
            }

            if (this.cfg.repository.mirror) {
                const mirror = await ws.pushMain(MIRROR);
                if (!mirror.ok) this.log(`${task.task_id} mirror push failed: ${tail(mirror.output, 3)}`);
            }
            this.log(`${task.task_id} ${task.status}: ${commits.length} commit(s), ${succeededAt} attempt(s)`);
        } catch (err) {
            task.status = 'failed';
            task.error = err?.message ?? String(err);
            this.log(`${task.task_id} failed: ${task.error}`);
        } finally {
            await finish();
        }
    }

    /**
     * Land the branch: replayed on the remote's current main, fast-forwarded, pushed; a push that lost a race
     * is replayed. {commits, preMergeSha, mergedSha, rebaseConflict, deployFailure}.
     */
    async land(task) {
        const {pushRetries, deployDonePattern, main} = this.cfg.repository;
        const done = deployDonePattern ? new RegExp(deployDonePattern) : null;
        const out = {commits: null, preMergeSha: '', mergedSha: '', rebaseConflict: null, deployFailure: null};
        const tries = Math.max(1, Number(pushRetries) || 1);
        for (let i = 1; i <= tries; i++) {
            await this.ws.checkout(task.branch).catch(() => {});
            const conflict = await this.ws.rebaseOnRemoteMain();
            if (conflict) {
                out.rebaseConflict = conflict;
                return out;
            }
            out.commits = await this.ws.commitsSince(`${DEPLOY}/${main}`);
            const {before, after} = await this.ws.fastForwardMain(task.branch);
            out.preMergeSha = before;
            out.mergedSha = after;
            const push = await this.ws.pushMain(DEPLOY);
            if (push.ok) {
                if (done && !done.test(push.output)) {
                    out.deployFailure = tail(push.output) || '(the push printed nothing)';
                    this.log(`${task.task_id} push output:\n${tail(push.output, 20)}`);
                } else {
                    out.deployFailure = null;
                    const said = tail(push.output, 5);
                    if (said) this.log(`${task.task_id} push: ${said.split('\n').at(-1)}`);
                }
                return out;
            }
            if (push.rejected && i < tries) {
                this.log(
                    `${task.task_id} push lost a race with another push (try ${i}/${tries}); replaying on the new ${main}`,
                );
                continue;
            }
            out.deployFailure = tail(push.output);
            return out;
        }
        return out;
    }
}

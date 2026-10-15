// The loop of a task against a real git remote and a scripted agent: landing, no changes, a check that
// fails and is fixed, a deploy the remote reports as failed and the rollback, a main that moved, the
// attempts running out, delivery rules, and the recovery after a restart.
import {test, describe, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {mergeConfig} from '../config.js';
import {Workspace} from '../lib/git.js';
import {Tasks, sumCosts} from '../lib/tasks.js';
import {costOf} from '../lib/runtime/claude-code.js';
import {commits, fakeNotifier, fakeRuntime, git, makeRemote, otherPush, tempDir} from './helpers.js';

const dirs = [];
after(() => {
    for (const d of dirs) fs.rmSync(d, {recursive: true, force: true});
});

async function setup(script, {cfg = {}, runtime: rt} = {}) {
    const remote = await makeRemote();
    dirs.push(remote.dir);
    const work = tempDir('stackwright-work');
    dirs.push(work);
    const config = mergeConfig({
        repository: {deploy: remote.url, main: remote.main, deployDonePattern: '\\[deploy\\] done:', pushRetries: 3},
        agent: {attempts: 3, attemptTimeoutMinutes: 1},
        ...cfg,
    });
    const workspace = new Workspace({dir: path.join(work, 'clone'), deploy: remote.url, main: remote.main});
    await workspace.ensure();
    const runtime = rt ?? fakeRuntime(script);
    const notifier = fakeNotifier();
    const tasks = new Tasks({cfg: config, workspace, runtime, notifier, storePath: path.join(work, 'tasks.json')});
    return {remote, workspace, runtime, notifier, tasks, work, config};
}

describe('a task', () => {
    test('lands: the agent commits on the branch, main is fast-forwarded and pushed, the hook deploys', async () => {
        const {remote, runtime, notifier, tasks} = await setup(commits('app.txt', 'v2\n', 'Bump app to v2'));
        const t = tasks.submit({description: 'Bump the app to v2', context: 'v1 is old'});
        assert.equal(t.status, 'queued');
        assert.match(t.branch, /^stackwright\/bump-the-app-to-v2-\d+-[a-z0-9]+$/);
        await tasks.idle();
        const done = tasks.get(t.task_id);
        assert.equal(done.status, 'completed', done.error);
        assert.equal(done.commits.length, 1);
        assert.deepEqual(await remote.log(), ['Bump app to v2', 'Initial']);
        assert.match(done.summary, /Landed on the first attempt/);
        assert.match(runtime.calls[0].prompt, /Bump the app to v2[\s\S]*Context from the caller[\s\S]*v1 is old/);
        assert.match(runtime.calls[0].systemPrompt, /do not push/);
        assert.equal(notifier.results.length, 1);
        assert.equal(notifier.results[0].status, 'completed');
        assert.equal(notifier.states.at(-1).status, 'idle');
        assert.ok(notifier.states.some((s) => s.status === 'running'));
    });

    test('is no-changes when the agent commits nothing', async () => {
        const {remote, notifier, tasks} = await setup(async () => 'Nothing to do: it already is v1.');
        const t = tasks.submit({description: 'Make sure the app is v1'});
        await tasks.idle();
        assert.equal(tasks.get(t.task_id).status, 'no-changes');
        assert.equal(tasks.get(t.task_id).summary, 'Nothing to do: it already is v1.');
        assert.deepEqual(await remote.log(), ['Initial']);
        assert.equal(notifier.results[0].status, 'no-changes');
    });

    test('runs the checks the commits touch; a failed check comes back to the agent, which resumes its session', async () => {
        const {remote, runtime, tasks, work} = await setup(
            async (call) => {
                const file = call.attempt === 1 ? 'broken\n' : 'fixed\n';
                const text = await commits('svc/x.txt', file, `Attempt ${call.attempt}`)(call);
                // Cumulative over the session: the resumed attempt's figure holds the first attempt too.
                const usd = call.attempt === 1 ? 0.5 : 0.8;
                return {
                    text,
                    cost: {
                        usd,
                        models: {'claude-opus-5-5': {input: 10, output: 5, cache_read: 0, cache_write: 0, usd}},
                    },
                };
            },
            {
                cfg: {
                    checks: [
                        {paths: ['svc/'], command: 'grep -q fixed svc/x.txt || { echo "x.txt is broken"; exit 1; }'},
                        {paths: ['other/'], command: 'exit 1'},
                    ],
                },
            },
        );
        const t = tasks.submit({description: 'Fix svc'});
        await tasks.idle();
        const done = tasks.get(t.task_id);
        assert.equal(done.status, 'completed', done.error);
        assert.equal(runtime.calls.length, 2);
        assert.match(runtime.calls[1].prompt, /The check `grep -q fixed[^`]*` failed:\nx\.txt is broken/);
        assert.equal(runtime.calls[1].resume, 'session-1');
        assert.deepEqual(await remote.log(), ['Attempt 2', 'Attempt 1', 'Initial']);
        assert.match(done.summary, /Landed after 2 attempts/);
        assert.equal(done.cost.usd, 0.8);
        assert.deepEqual(done.cost.models['claude-opus-5-5'], {
            input: 10,
            output: 5,
            cache_read: 0,
            cache_write: 0,
            usd: 0.8,
        });
        assert.ok(fs.existsSync(path.join(work, 'tasks.json')));
    });

    test('rolls main back when the remote reports a failed deploy, and lands the fix on the next attempt', async () => {
        const {remote, runtime, tasks} = await setup(async (call) => {
            if (call.attempt === 2) remote.failDeploy(null);
            return commits('app.txt', `v${call.attempt + 1}\n`, `Attempt ${call.attempt}`)(call);
        });
        const before = await remote.head();
        remote.failDeploy('the container did not come up');
        const t = tasks.submit({description: 'Bump the app'});
        await tasks.idle();
        const done = tasks.get(t.task_id);
        assert.equal(done.status, 'completed', done.error);
        assert.equal(runtime.calls.length, 2);
        assert.match(runtime.calls[1].prompt, /The deploy failed:[\s\S]*the container did not come up/);
        assert.deepEqual(await remote.log(), ['Attempt 2', 'Attempt 1', 'Initial']);
        assert.notEqual(await remote.head(), before);
    });

    test('replays the branch when main moved while the agent worked', async () => {
        const {remote, tasks} = await setup(async (call) => {
            await otherPush(remote, 'other.txt', 'hello\n', 'Someone else');
            return commits('app.txt', 'v2\n', 'Bump app')(call);
        });
        const t = tasks.submit({description: 'Bump the app'});
        await tasks.idle();
        assert.equal(tasks.get(t.task_id).status, 'completed', tasks.get(t.task_id).error);
        assert.deepEqual(await remote.log(), ['Bump app', 'Someone else', 'Initial']);
    });

    test('hands a rebase conflict to the agent', async () => {
        const {remote, runtime, tasks} = await setup(async (call) => {
            if (call.attempt === 1) {
                await otherPush(remote, 'app.txt', 'v9\n', 'Someone else bumps');
                return commits('app.txt', 'v2\n', 'Bump app')(call);
            }
            // The agent resolves it as told: rebase, keep both sides, finish.
            await git(call.cwd, 'fetch', 'deploy');
            await git(call.cwd, 'rebase', 'deploy/main').catch(() => {});
            fs.writeFileSync(path.join(call.cwd, 'app.txt'), 'v9+v2\n');
            await git(call.cwd, 'add', 'app.txt');
            await git(call.cwd, '-c', 'core.editor=true', 'rebase', '--continue');
            return 'resolved';
        });
        const t = tasks.submit({description: 'Bump the app'});
        await tasks.idle();
        assert.equal(tasks.get(t.task_id).status, 'completed', tasks.get(t.task_id).error);
        assert.match(runtime.calls[1].prompt, /hit conflicts/);
        assert.deepEqual(await remote.log(), ['Bump app', 'Someone else bumps', 'Initial']);
    });

    test('fails and escalates when the attempts run out', async () => {
        const {remote, notifier, tasks} = await setup(async (call) =>
            commits('app.txt', `v${call.attempt + 1}\n`, `Attempt ${call.attempt}`)(call),
        );
        remote.failDeploy('never comes up');
        const t = tasks.submit({description: 'Bump the app'});
        await tasks.idle();
        const done = tasks.get(t.task_id);
        assert.equal(done.status, 'failed');
        assert.match(done.error, /not landed after 3 attempts/);
        assert.equal(notifier.states.at(-1).status, 'action_required');
        assert.match(notifier.states.at(-1).message, /failed after 3 attempts/);
        assert.deepEqual(await remote.log(), ['Initial']);
        // The next task clears the escalation.
        remote.failDeploy(null);
        tasks.submit({description: 'Try again'});
        assert.equal(notifier.states.at(-1).status, 'running');
        await tasks.idle();
        assert.equal(notifier.states.at(-1).status, 'idle');
    });

    test('leaves main alone when the deploy failed and someone else pushed meanwhile', async () => {
        const {remote, notifier, tasks} = await setup(async (call) => {
            if (call.attempt === 1) {
                await commits('app.txt', 'v2\n', 'Bump app')(call);
                return 'done';
            }
            return 'nothing more';
        });
        remote.failDeploy('boom');
        // The hook is where "someone else" lands: a second push arrives between the failed deploy and the check.
        // (A hook inherits GIT_DIR; the other developer's commands must not.)
        const hook = path.join(remote.url, 'hooks', 'post-receive');
        const other = await remote.other();
        fs.writeFileSync(
            hook,
            [
                '#!/bin/sh',
                'echo "[deploy] failed: boom" >&2',
                `( unset GIT_DIR GIT_WORK_TREE; cd ${other} && git fetch -q origin && git checkout -q -B main origin/main && echo late > late.txt && git add late.txt && git -c user.name=O -c user.email=o@x commit -q -m "Late push" && git push -q origin main ) >/dev/null 2>&1`,
                '',
            ].join('\n'),
        );
        const t = tasks.submit({description: 'Bump the app'});
        await tasks.idle();
        const done = tasks.get(t.task_id);
        assert.equal(done.status, 'failed');
        assert.match(done.error, /concurrent push/);
        assert.equal(notifier.states.at(-1).status, 'action_required');
        assert.deepEqual(await remote.log(), ['Late push', 'Bump app', 'Initial']);
    });

    test('delivers results as notify says, with the task’s own webhook', async () => {
        let n = 0;
        const {notifier, tasks} = await setup(async (call) => commits(`file-${++n}.txt`, 'x\n')(call));
        const a = tasks.submit({description: 'A', notify: 'never'});
        const b = tasks.submit({description: 'B', notify: 'on_failure'});
        const c = tasks.submit({description: 'C', webhook: 'http://localhost:1/hook'});
        await tasks.idle();
        for (const t of [a, b, c]) assert.equal(tasks.get(t.task_id).status, 'completed', tasks.get(t.task_id).error);
        // The fake notifier keeps every call; the rules live in Notifier.result (notify.test.js).
        assert.equal(notifier.results.length, 3);
        assert.equal(notifier.results[2].webhook, 'http://localhost:1/hook');
        assert.throws(() => tasks.submit({description: 'D', notify: 'sometimes'}), /notify must be one of/);
        assert.throws(() => tasks.submit({description: 'E', webhook: 'ftp://x'}), /webhook must be/);
        assert.throws(() => tasks.submit({description: '  '}), /description required/);
    });

    test('is refused while the runtime has no credential, and the state says so', async () => {
        const {notifier, tasks} = await setup(null, {
            runtime: fakeRuntime(async () => 'x', {auth: 'none', ready: false}),
            cfg: {agent: {auth: 'subscription'}},
        });
        tasks.publishState();
        assert.equal(notifier.states.at(-1).status, 'action_required');
        assert.match(notifier.states.at(-1).message, /no subscription login/);
        assert.match(tasks.notReadyMessage, /CLAUDE_CODE_OAUTH_TOKEN/);
    });
});

describe('after a restart', () => {
    test('a running task whose branch landed is completed, one that did not is failed, a queued one is failed', async () => {
        const {remote, workspace, notifier, tasks, work, config} = await setup(commits('app.txt', 'v2\n', 'Landed'));
        const landed = tasks.submit({description: 'Landed change'});
        await tasks.idle();
        assert.equal(tasks.get(landed.task_id).status, 'completed');
        // Rewrite the records as a crash would have left them.
        const records = JSON.parse(fs.readFileSync(path.join(work, 'tasks.json'), 'utf-8'));
        records[0].status = 'running';
        delete records[0].finished_at;
        delete records[0].summary;
        records.push({
            task_id: 'x-lost',
            branch: 'stackwright/lost-x',
            description: 'Lost',
            status: 'running',
            started_at: 1,
        });
        records.push({
            task_id: 'x-queued',
            branch: 'stackwright/queued-x',
            description: 'Queued',
            status: 'queued',
            started_at: 2,
        });
        fs.writeFileSync(path.join(work, 'tasks.json'), JSON.stringify(records));
        await git(workspace.dir, 'checkout', '-q', '-b', 'stackwright/lost-x');
        fs.writeFileSync(path.join(workspace.dir, 'lost.txt'), 'never pushed\n');
        await git(workspace.dir, 'add', 'lost.txt');
        await git(workspace.dir, 'commit', '-q', '-m', 'Lost');
        await git(workspace.dir, 'checkout', '-q', 'main');
        const again = new Tasks({
            cfg: config,
            workspace,
            runtime: fakeRuntime(async () => 'x'),
            notifier,
            storePath: path.join(work, 'tasks.json'),
        });
        await again.recover();
        assert.equal(again.get(landed.task_id).status, 'completed');
        assert.match(again.get(landed.task_id).summary, /lost to a restart/);
        assert.equal(again.get('x-lost').status, 'failed');
        assert.equal(again.get('x-queued').status, 'failed');
        assert.equal(notifier.results.filter((r) => r.error?.includes('restarted')).length, 2);
        assert.deepEqual(await remote.log(), ['Landed', 'Initial']);
    });
});

describe('the cost of a task', () => {
    test('is read from the result message, per model', () => {
        assert.equal(costOf({type: 'result', subtype: 'success'}), null);
        assert.deepEqual(
            costOf({
                type: 'result',
                total_cost_usd: 0.42,
                modelUsage: {
                    'claude-opus-5-5': {
                        inputTokens: 1,
                        outputTokens: 2,
                        cacheReadInputTokens: 3,
                        cacheCreationInputTokens: 4,
                        costUSD: 0.42,
                        webSearchRequests: 0,
                    },
                },
            }),
            {usd: 0.42, models: {'claude-opus-5-5': {input: 1, output: 2, cache_read: 3, cache_write: 4, usd: 0.42}}},
        );
    });

    test('adds up the chains of sessions', () => {
        const m = (usd, input) => ({input, output: 0, cache_read: 0, cache_write: 0, usd});
        const total = sumCosts([
            {usd: 0.1, models: {a: m(0.1, 10)}},
            {usd: 0.2, models: {a: m(0.15, 20), b: m(0.05, 5)}},
        ]);
        assert.deepEqual(total, {usd: 0.3, models: {a: m(0.25, 30), b: m(0.05, 5)}});
    });

    test('a fresh session adds to the task; the resumed one above replaced its chain', async () => {
        // Attempt 1 reports no session id, so attempt 2 cannot resume it and starts afresh.
        const base = fakeRuntime(async (call) => {
            const text = await commits(
                'svc/x.txt',
                call.attempt === 1 ? 'broken\n' : 'fixed\n',
                `Attempt ${call.attempt}`,
            )(call);
            return {text, cost: {usd: call.attempt === 1 ? 0.3 : 0.7, models: {}}};
        });
        const runtime = {
            ...base,
            async run(call) {
                const r = await base.run(call);
                return base.calls.length === 1 ? {...r, sessionId: null} : r;
            },
        };
        const {tasks} = await setup(null, {
            runtime,
            cfg: {checks: [{paths: ['svc/'], command: 'grep -q fixed svc/x.txt || { echo "broken"; exit 1; }'}]},
        });
        const t = tasks.submit({description: 'Fix svc'});
        await tasks.idle();
        const done = tasks.get(t.task_id);
        assert.equal(done.status, 'completed', done.error);
        assert.equal(base.calls.length, 2);
        assert.equal(base.calls[1].resume, null);
        assert.equal(done.cost.usd, 1);
    });
});

// The API against the engine with a fake runtime: the task round trip, health, the token, the
// setup-token endpoints only when switched on.
import {test, describe, after, before} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import {mergeConfig} from '../config.js';
import {createApi} from '../lib/api.js';
import {Workspace} from '../lib/git.js';
import {Tasks} from '../lib/tasks.js';
import {commits, fakeNotifier, fakeRuntime, makeRemote, tempDir} from './helpers.js';

const dirs = [];
let base;
let server;
let tasks;
let runtime;

before(async () => {
    const remote = await makeRemote();
    dirs.push(remote.dir);
    const work = tempDir('stackwright-api');
    dirs.push(work);
    const workspace = new Workspace({dir: path.join(work, 'clone'), deploy: remote.url, main: remote.main});
    await workspace.ensure();
    runtime = fakeRuntime(commits('app.txt', 'v2\n'));
    runtime.startSetupToken = async () => 'https://claude.ai/oauth/authorize?state=abc';
    runtime.finishSetupToken = async (code) => {
        if (code !== 'good#abc') throw new Error('Claude did not accept the code');
        return 'sk-ant-oat01-test';
    };
    runtime.useToken = (t) => (runtime.token = t);
    runtime.testPrompt = async () => 'ok';
    tasks = new Tasks({
        cfg: mergeConfig({repository: {deploy: remote.url, main: remote.main}}),
        workspace,
        runtime,
        notifier: fakeNotifier(),
        storePath: path.join(work, 'tasks.json'),
    });
    server = createApi({
        tasks,
        runtime,
        pkg: {name: 'stackwright', version: 'test'},
        token: 'secret',
        setupToken: true,
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
    await new Promise((r) => server.close(r));
    for (const d of dirs) fs.rmSync(d, {recursive: true, force: true});
});

const call = (method, p, body, token = 'secret') =>
    fetch(`${base}${p}`, {
        method,
        headers: {'Content-Type': 'application/json', ...(token ? {Authorization: `Bearer ${token}`} : {})},
        body: body === undefined ? undefined : JSON.stringify(body),
    }).then(async (r) => ({status: r.status, body: await r.json()}));

describe('the API', () => {
    test('wants the token', async () => {
        assert.equal((await call('GET', '/health', undefined, null)).status, 401);
        assert.equal((await call('GET', '/health', undefined, 'wrong')).status, 401);
    });

    test('takes a task and tells about it', async () => {
        const health = await call('GET', '/health');
        assert.equal(health.body.ok, true);
        assert.equal(health.body.auth, 'subscription');
        const posted = await call('POST', '/tasks', {description: 'Bump the app', notify: 'never'});
        assert.equal(posted.status, 202, JSON.stringify(posted.body));
        assert.equal(posted.body.status, 'queued');
        await tasks.idle();
        const one = await call('GET', `/tasks/${posted.body.task_id}`);
        assert.equal(one.body.status, 'completed');
        assert.equal(one.body.notify, 'never');
        const all = await call('GET', '/tasks');
        assert.equal(all.body.length, 1);
        assert.equal((await call('GET', '/tasks/nope')).status, 404);
        assert.equal((await call('POST', '/tasks', {})).status, 400);
        assert.equal((await call('POST', '/tasks', {description: 'x', notify: 'maybe'})).status, 400);
    });

    test('refuses tasks while the runtime is not ready', async () => {
        runtime.ready = false;
        const r = await call('POST', '/tasks', {description: 'x'});
        assert.equal(r.status, 503);
        assert.match(r.body.error, /takes no tasks/);
        runtime.ready = true;
    });

    test('drives setup-token when switched on, and not otherwise', async () => {
        const start = await call('POST', '/auth/setup-token/start', {});
        assert.equal(start.body.url, 'https://claude.ai/oauth/authorize?state=abc');
        const bad = await call('POST', '/auth/setup-token/finish', {code: 'bad'});
        assert.equal(bad.status, 400);
        const ok = await call('POST', '/auth/setup-token/finish', {callback_url: 'good#abc'});
        assert.equal(ok.status, 200, JSON.stringify(ok.body));
        assert.equal(ok.body.token, 'sk-ant-oat01-test');
        assert.equal(runtime.token, 'sk-ant-oat01-test');
        assert.equal((await call('POST', '/auth/setup-token/finish', {})).status, 400);

        const off = createApi({tasks, runtime, pkg: {name: 'x', version: 'y'}});
        await new Promise((r) => off.listen(0, '127.0.0.1', r));
        const r = await fetch(`http://127.0.0.1:${off.address().port}/auth/setup-token/start`, {method: 'POST'});
        assert.equal(r.status, 404);
        await new Promise((res) => off.close(res));
    });
});

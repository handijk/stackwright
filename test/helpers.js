/**
 * What the scenarios work with: a bare "deploy" remote with a post-receive hook whose verdict the test sets,
 * a clone for the "other developer", a fake runtime that edits and commits as the test scripts it, and a
 * notifier that keeps what it was given.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {run} from '../lib/git.js';

export function tempDir(name) {
    return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.com'];

export async function git(cwd, ...args) {
    const {stdout} = await run('git', [...ID, ...args], {cwd});
    return stdout.trim();
}

/**
 * A bare repository with one commit on `main` and a post-receive hook that prints `[deploy] done: <sha>`,
 * or `[deploy] failed: <reason>` while the file `deploy-fail` exists next to it.
 */
export async function makeRemote({main = 'main'} = {}) {
    const dir = tempDir('stackwright-remote');
    const bare = path.join(dir, 'repo.git');
    await git(dir, 'init', '--bare', '-b', main, bare);
    const hook = path.join(bare, 'hooks', 'post-receive');
    fs.writeFileSync(
        hook,
        `#!/bin/sh\nif [ -f "$GIT_DIR/deploy-fail" ]; then echo "[deploy] failed: $(cat "$GIT_DIR/deploy-fail")" >&2; else echo "[deploy] done: $(git rev-parse ${main})" >&2; fi\n`,
    );
    fs.chmodSync(hook, 0o755);
    const seed = path.join(dir, 'seed');
    await git(dir, 'clone', '-q', bare, seed);
    await git(seed, 'checkout', '-q', '-b', main);
    fs.writeFileSync(path.join(seed, 'README.md'), '# a stack\n');
    fs.writeFileSync(path.join(seed, 'app.txt'), 'v1\n');
    await git(seed, 'add', '.');
    await git(seed, 'commit', '-q', '-m', 'Initial');
    await git(seed, 'push', '-q', 'origin', main);
    return {
        dir,
        url: bare,
        main,
        /** A clone for someone else's pushes. */
        async other() {
            const d = path.join(dir, `other-${Math.random().toString(36).slice(2, 6)}`);
            await git(dir, 'clone', '-q', bare, d);
            return d;
        },
        async head() {
            return git(bare, 'rev-parse', main);
        },
        async log() {
            const out = await git(bare, 'log', main, '--format=%s');
            return out.split('\n').filter(Boolean);
        },
        failDeploy(reason) {
            if (reason) fs.writeFileSync(path.join(bare, 'deploy-fail'), reason);
            else fs.rmSync(path.join(bare, 'deploy-fail'), {force: true});
        },
    };
}

/** Someone else lands a commit on the remote's main. */
export async function otherPush(remote, file, content, message) {
    const d = await remote.other();
    fs.writeFileSync(path.join(d, file), content);
    await git(d, 'add', '.');
    await git(d, 'commit', '-q', '-m', message);
    await git(d, 'push', '-q', 'origin', remote.main);
    return d;
}

/**
 * The runtime as the engine sees it. `script(call)` runs per attempt with {prompt, cwd, resume, attempt}
 * and does what the agent would: edit files, commit. Its return is the agent's last text.
 */
export function fakeRuntime(script, {auth = 'subscription', ready = true} = {}) {
    const calls = [];
    return {
        calls,
        authInUse: auth,
        ready,
        async run({prompt, cwd, systemPrompt, resume, abortController}) {
            const call = {prompt, cwd, systemPrompt, resume, attempt: calls.length + 1, abortController};
            calls.push(call);
            const text = (await script(call)) ?? 'done';
            return {sessionId: `session-${calls.length}`, text, apiKeySource: 'none', turns: 1};
        },
    };
}

/** An agent that writes `content` to `file` and commits with `message`. */
export const commits =
    (file, content, message = `Change ${file}`) =>
    async ({cwd}) => {
        fs.mkdirSync(path.dirname(path.join(cwd, file)), {recursive: true});
        fs.writeFileSync(path.join(cwd, file), content);
        await git(cwd, 'add', '.');
        await git(cwd, 'commit', '-q', '-m', message);
        return `I changed ${file}.`;
    };

/** A notifier that keeps what it was given. */
export function fakeNotifier() {
    const results = [];
    const states = [];
    return {
        results,
        states,
        async result(task) {
            results.push(JSON.parse(JSON.stringify(task)));
            return true;
        },
        state(doc) {
            states.push(doc);
        },
    };
}

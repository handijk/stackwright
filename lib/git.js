/**
 * git as child processes, and the private clone: made from the deploy remote, reset to its main before
 * every task, a branch per task, the landing (rebase, fast-forward, push) and the rollback.
 */

import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** Run a command. Resolves with its output; rejects with an Error that carries the output when it fails. */
export function run(cmd, args, {cwd, env = process.env, timeoutMs = 0, input} = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(cmd, args, {cwd, env});
        let stdout = '';
        let stderr = '';
        const timer = timeoutMs > 0 ? setTimeout(() => child.kill('SIGKILL'), timeoutMs) : null;
        child.stdout.on('data', (d) => (stdout += d));
        child.stderr.on('data', (d) => (stderr += d));
        child.on('error', (err) => {
            if (timer) clearTimeout(timer);
            reject(err);
        });
        child.on('close', (code, signal) => {
            if (timer) clearTimeout(timer);
            if (code === 0) return resolve({stdout, stderr});
            const how = signal ? `killed by ${signal}${timer ? ` after ${timeoutMs} ms` : ''}` : `exited ${code}`;
            const err = new Error(`${cmd} ${args.join(' ')} ${how}: ${(stderr || stdout).trim()}`);
            Object.assign(err, {stdout, stderr, code, signal});
            reject(err);
        });
        if (input !== undefined) child.stdin.end(input);
        else child.stdin.end();
    });
}

export const DEPLOY = 'deploy';
export const MIRROR = 'mirror';

const REJECTED = /non-fast-forward|\[rejected\]|fetch first|failed to push some refs/i;

export class Workspace {
    /**
     * @param {object} a
     * @param {string} a.dir the clone
     * @param {string} a.deploy the remote whose push deploys
     * @param {string} [a.mirror] pushed after the deploy remote
     * @param {string} [a.main]
     * @param {{name?: string, email?: string}} [a.user] the identity of the commits
     * @param {(msg: string) => void} [a.log]
     */
    constructor({dir, deploy, mirror = null, main = 'main', user = {}, log = () => {}}) {
        this.dir = dir;
        this.deploy = deploy;
        this.mirror = mirror;
        this.main = main;
        this.user = user;
        this.log = log;
    }

    async git(args) {
        const {stdout} = await run('git', args, {cwd: this.dir});
        return stdout.trim();
    }

    /** The clone exists, has its remotes and identity, and knows the remote's main. */
    async ensure() {
        if (!fs.existsSync(path.join(this.dir, '.git'))) {
            this.log(`cloning ${this.deploy} into ${this.dir}`);
            fs.mkdirSync(this.dir, {recursive: true});
            await run('git', ['clone', '-o', DEPLOY, this.deploy, this.dir], {cwd: path.dirname(this.dir)});
        }
        await this.setRemote(DEPLOY, this.deploy);
        if (this.mirror) await this.setRemote(MIRROR, this.mirror);
        await this.git(['config', 'user.name', this.user.name ?? 'stackwright']);
        await this.git(['config', 'user.email', this.user.email ?? 'stackwright@localhost']);
        await this.git(['fetch', DEPLOY]).catch((err) => this.log(`fetch from ${DEPLOY} failed: ${err.message}`));
    }

    async setRemote(name, url) {
        try {
            await this.git(['remote', 'set-url', name, url]);
        } catch {
            await this.git(['remote', 'add', name, url]);
        }
    }

    /** The clone at the remote's main, whatever a previous task left, and a new branch from it. */
    async startBranch(branch) {
        await this.git(['fetch', DEPLOY, this.main]);
        await this.discardUncommitted();
        await this.git(['checkout', '-B', this.main, `${DEPLOY}/${this.main}`]);
        await this.git(['checkout', '-b', branch]);
    }

    head() {
        return this.git(['rev-parse', 'HEAD']);
    }

    headRef() {
        return this.git(['symbolic-ref', 'HEAD']).catch(() => '');
    }

    /** The commits of HEAD since `ref`, newest first: [{sha, subject}]. */
    async commitsSince(ref) {
        const raw = await this.git(['log', `${ref}..HEAD`, '--format=%H %s']).catch(() => '');
        return raw
            ? raw
                  .split('\n')
                  .filter(Boolean)
                  .map((l) => ({sha: l.slice(0, l.indexOf(' ')), subject: l.slice(l.indexOf(' ') + 1)}))
            : [];
    }

    /** The files HEAD changed since it left `ref`. */
    async changedFiles(ref) {
        const raw = await this.git(['diff', '--name-only', `${ref}...HEAD`]).catch(() => '');
        return raw ? raw.split('\n').filter(Boolean) : [];
    }

    async discardUncommitted() {
        await this.git(['reset', '--hard', 'HEAD']).catch(() => {});
        await this.git(['clean', '-fd']).catch(() => {});
    }

    checkout(ref) {
        return this.git(['checkout', ref]);
    }

    /** Replay the branch on the remote's current main. Resolves with the conflict's text when it does not apply. */
    async rebaseOnRemoteMain() {
        await this.git(['fetch', DEPLOY, this.main]).catch(() => {});
        try {
            await this.git(['rebase', `${DEPLOY}/${this.main}`]);
            return null;
        } catch (err) {
            await this.git(['rebase', '--abort']).catch(() => {});
            return String(err.message).split('\n').slice(-8).join('\n');
        }
    }

    /** Local main becomes the remote's, fast-forwarded to the branch: {before, after}. */
    async fastForwardMain(branch) {
        await this.git(['checkout', this.main]);
        await this.git(['reset', '--hard', `${DEPLOY}/${this.main}`]);
        const before = await this.head();
        await this.git(['merge', '--ff-only', branch]);
        return {before, after: await this.head()};
    }

    /** Push main to a remote. The hook's output comes back; `rejected` when another push won. */
    async pushMain(remote = DEPLOY, {force = false} = {}) {
        try {
            const {stdout, stderr} = await run('git', ['push', ...(force ? ['--force'] : []), remote, this.main], {
                cwd: this.dir,
            });
            return {ok: true, output: [stdout, stderr].filter(Boolean).join('\n')};
        } catch (err) {
            const output = err.message || String(err);
            return {ok: false, output, rejected: REJECTED.test(output)};
        }
    }

    /** The remote's main right now, or '' when it cannot be asked. */
    async remoteMain() {
        await this.git(['fetch', DEPLOY, this.main]).catch(() => {});
        return this.git(['rev-parse', `${DEPLOY}/${this.main}`]).catch(() => '');
    }

    isAncestor(ref, of) {
        return run('git', ['merge-base', '--is-ancestor', ref, of], {cwd: this.dir}).then(
            () => true,
            () => false,
        );
    }

    async resetMainTo(sha) {
        await this.git(['checkout', this.main]).catch(() => {});
        await this.git(['reset', '--hard', sha]);
    }
}

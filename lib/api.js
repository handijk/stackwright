/**
 * The HTTP API: tasks in, tasks and health out, and Claude Code's own login when that is switched on.
 * JSON in, JSON out; a bearer token when configured, otherwise bind it to localhost or put it behind a proxy.
 */

import http from 'node:http';

const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(text)});
    res.end(text);
};

const readBody = (req, limit = 1_000_000) =>
    new Promise((resolve) => {
        const chunks = [];
        let size = 0;
        req.on('data', (c) => {
            size += c.length;
            if (size <= limit) chunks.push(c);
        });
        req.on('end', () => {
            if (size > limit) return resolve(null);
            try {
                resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : {});
            } catch {
                resolve(null);
            }
        });
    });

/**
 * @param {object} a
 * @param {import('./tasks.js').Tasks} a.tasks
 * @param {object} a.runtime
 * @param {object} a.pkg
 * @param {string|null} [a.token]
 * @param {boolean} [a.setupToken]
 * @param {(msg: string) => void} [a.log]
 */
export function createApi({tasks, runtime, pkg, token = null, setupToken = false, log = () => {}}) {
    return http.createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (token && req.headers.authorization !== `Bearer ${token}`)
                return json(res, 401, {error: 'unauthorized'});
            const p = url.pathname;
            if (req.method === 'GET' && p === '/health')
                return json(res, 200, {
                    ok: true,
                    name: pkg.name,
                    version: pkg.version,
                    queued: tasks.queued,
                    running: tasks.running,
                    auth: runtime.authInUse,
                    ready: runtime.ready,
                });
            if (req.method === 'GET' && p === '/tasks') return json(res, 200, tasks.list());
            const one = /^\/tasks\/([^/]+)$/.exec(p);
            if (req.method === 'GET' && one) {
                const t = tasks.get(one[1]);
                return t ? json(res, 200, t) : json(res, 404, {error: 'not found'});
            }
            if (req.method === 'POST' && p === '/tasks') {
                const body = await readBody(req);
                if (!body) return json(res, 400, {error: 'invalid JSON body'});
                if (!runtime.ready) return json(res, 503, {error: tasks.notReadyMessage});
                try {
                    const t = tasks.submit(body);
                    return json(res, 202, {task_id: t.task_id, branch: t.branch, status: t.status});
                } catch (err) {
                    return json(res, 400, {error: err.message});
                }
            }
            if (setupToken && req.method === 'POST' && p === '/auth/setup-token/start') {
                try {
                    return json(res, 200, {url: await runtime.startSetupToken(), valid_minutes: 10});
                } catch (err) {
                    return json(res, 500, {error: err.message});
                }
            }
            if (setupToken && req.method === 'POST' && p === '/auth/setup-token/finish') {
                const body = await readBody(req);
                const code = String(body?.code ?? body?.callback_url ?? '').trim();
                if (!code) return json(res, 400, {error: 'code or callback_url required'});
                try {
                    const tokenGot = await runtime.finishSetupToken(code);
                    runtime.useToken(tokenGot);
                    log('logged in with a subscription token from setup-token');
                    tasks.publishState();
                    return json(res, 200, {ok: true, token: tokenGot, test: await runtime.testPrompt()});
                } catch (err) {
                    return json(res, 400, {error: err.message});
                }
            }
            json(res, 404, {error: 'not found'});
        } catch (err) {
            log(`api: ${err.message}`);
            json(res, 500, {error: err.message});
        }
    });
}

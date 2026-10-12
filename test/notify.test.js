// Delivery: the notify rules, the webhook with its retries, the task's own webhook, MQTT topics.
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {Notifier, resultDocument} from '../lib/notify.js';

function fakes() {
    const posts = [];
    const published = [];
    const client = {
        handlers: {},
        on(ev, fn) {
            this.handlers[ev] = fn;
        },
        publish(topic, payload, opts) {
            published.push({topic, doc: JSON.parse(payload), retain: opts.retain});
        },
        end(_f, _o, cb) {
            cb();
        },
    };
    let fail = 0;
    const fetchImpl = async (url, init) => {
        posts.push({url, body: JSON.parse(init.body)});
        if (fail > 0) {
            fail--;
            return {ok: false, status: 500};
        }
        return {ok: true, status: 200};
    };
    return {posts, published, client, fetchImpl, failNext: (n) => (fail = n)};
}

const task = (over = {}) => ({
    task_id: 't1',
    branch: 'stackwright/x-t1',
    description: 'X',
    status: 'completed',
    commits: ['abc'],
    summary: 'done',
    started_at: 1,
    finished_at: 1_700_000_000_000,
    ...over,
});

describe('the notifier', () => {
    test('delivers to the webhook and the results topic, and the state retained', async () => {
        const f = fakes();
        const n = new Notifier({
            webhook: 'http://hook/x',
            mqtt: {url: 'mqtt://b', resultsTopic: 'sw/results', stateTopic: 'sw/state'},
            fetch: f.fetchImpl,
            connect: () => f.client,
            retryDelaysMs: [],
        });
        assert.equal(await n.result(task()), true);
        assert.equal(f.posts.length, 1);
        assert.equal(f.posts[0].url, 'http://hook/x');
        assert.deepEqual(f.posts[0].body, resultDocument(task()));
        assert.equal(f.posts[0].body.finished_at, '2023-11-14T22:13:20.000Z');
        assert.equal(f.posts[0].body.error, null);
        assert.deepEqual(f.published[0], {topic: 'sw/results', doc: resultDocument(task()), retain: false});
        n.state({status: 'idle'});
        assert.deepEqual(f.published[1], {topic: 'sw/state', doc: {status: 'idle'}, retain: true});
        await n.close();
    });

    test('follows notify, and a task’s own webhook', async () => {
        const f = fakes();
        const n = new Notifier({webhook: 'http://hook/x', fetch: f.fetchImpl, retryDelaysMs: []});
        assert.equal(await n.result(task({notify: 'never'})), false);
        assert.equal(await n.result(task({notify: 'on_failure'})), false);
        assert.equal(await n.result(task({notify: 'on_failure', status: 'failed', error: 'boom'})), true);
        assert.equal(await n.result(task({webhook: 'http://mine/y'})), true);
        assert.deepEqual(
            f.posts.map((p) => p.url),
            ['http://hook/x', 'http://mine/y'],
        );
        assert.equal(f.posts[0].body.error, 'boom');
    });

    test('retries the webhook as many times as it has delays', async () => {
        const f = fakes();
        const n = new Notifier({webhook: 'http://hook/x', fetch: f.fetchImpl, retryDelaysMs: [1, 1]});
        f.failNext(2);
        assert.equal(await n.result(task()), true);
        assert.equal(f.posts.length, 3);
        f.failNext(5);
        await n.result(task());
        assert.equal(f.posts.length, 6);
    });
});

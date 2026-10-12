/**
 * Where results and the state go: the webhook (the task's own or the configured one, retried), the
 * results topic, and the state retained on MQTT.
 */

import mqtt from 'mqtt';

/** The result of a task as it is delivered. */
export function resultDocument(task) {
    return {
        task_id: task.task_id,
        branch: task.branch,
        status: task.status,
        commits: task.commits ?? [],
        summary: task.summary ?? '',
        error: task.error ?? null,
        description: task.description,
        notify: task.notify ?? 'always',
        finished_at: new Date(task.finished_at ?? Date.now()).toISOString(),
    };
}

export class Notifier {
    /**
     * @param {object} a
     * @param {string|null} [a.webhook]
     * @param {object|null} [a.mqtt] {url, username, password, resultsTopic, stateTopic}
     * @param {(msg: string) => void} [a.log]
     * @param {typeof fetch} [a.fetch]
     * @param {typeof mqtt.connect} [a.connect]
     * @param {number[]} [a.retryDelaysMs] the waits between webhook tries
     */
    constructor({
        webhook = null,
        mqtt: mq = null,
        log = () => {},
        fetch: fetchImpl = globalThis.fetch,
        connect = mqtt.connect,
        retryDelaysMs = [5_000, 30_000],
    } = {}) {
        this.webhook = webhook;
        this.log = log;
        this.fetch = fetchImpl;
        this.retryDelaysMs = retryDelaysMs;
        this.client = null;
        this.topics = null;
        if (mq?.url) {
            this.topics = {results: mq.resultsTopic, state: mq.stateTopic};
            this.client = connect(mq.url, {
                username: mq.username,
                password: mq.password,
                clientId: `stackwright_${Math.random().toString(16).slice(2, 10)}`,
                reconnectPeriod: 5000,
            });
            this.client.on('connect', () => log(`mqtt connected ${mq.url}`));
            this.client.on('error', (err) => log(`mqtt: ${err?.message ?? err}`));
        }
    }

    /** Deliver a task's result as its `notify` allows. Resolves with whether it was delivered anywhere. */
    async result(task) {
        const notify = task.notify ?? 'always';
        if (notify === 'never' || (notify === 'on_failure' && task.status !== 'failed')) return false;
        const doc = resultDocument(task);
        this.publish(this.topics?.results, doc, false);
        const url = task.webhook ?? this.webhook;
        if (url) await this.post(url, doc);
        return true;
    }

    state(doc) {
        this.publish(this.topics?.state, doc, true);
    }

    publish(topic, doc, retain) {
        if (!this.client || !topic) return;
        this.client.publish(topic, JSON.stringify(doc), {retain, qos: 0});
    }

    async post(url, doc) {
        for (let i = 0; ; i++) {
            try {
                const res = await this.fetch(url, {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify(doc),
                    signal: AbortSignal.timeout(30_000),
                });
                if (res.ok) return true;
                throw new Error(`HTTP ${res.status}`);
            } catch (err) {
                this.log(`webhook ${url}: ${err.message}`);
                if (i >= this.retryDelaysMs.length) return false;
                await new Promise((r) => setTimeout(r, this.retryDelaysMs[i]));
            }
        }
    }

    close() {
        return new Promise((resolve) => (this.client ? this.client.end(false, {}, () => resolve()) : resolve()));
    }
}

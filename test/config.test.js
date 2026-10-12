import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {mergeConfig, parseListen, problems} from '../config.js';
import {applicable} from '../lib/checks.js';
import {systemPrompt} from '../lib/prompt.js';
import {slugify} from '../lib/tasks.js';

describe('the configuration', () => {
    test('merges over the defaults, deep for objects and whole for lists', () => {
        const cfg = mergeConfig({repository: {deploy: 'x'}, agent: {attempts: 5}, checks: [{command: 'true'}]});
        assert.equal(cfg.repository.main, 'main');
        assert.equal(cfg.agent.attempts, 5);
        assert.equal(cfg.agent.model, 'claude-opus-5-5');
        assert.deepEqual(cfg.checks, [{command: 'true'}]);
        assert.equal(cfg.notify.mqtt, null);
        assert.deepEqual(mergeConfig({notify: {mqtt: {url: 'mqtt://b'}}}).notify.mqtt, {
            url: 'mqtt://b',
            resultsTopic: 'stackwright/results',
            stateTopic: 'stackwright/state',
        });
    });

    test('names what keeps it from running', () => {
        assert.deepEqual(problems(mergeConfig({repository: {deploy: 'x'}})), []);
        const bad = problems(
            mergeConfig({
                agent: {auth: 'magic', attempts: 0},
                checks: [{paths: 'a'}],
                repository: {deployDonePattern: '('},
                notify: {mqtt: {}},
            }),
        );
        assert.equal(bad.length, 7, bad.join('\n'));
        assert.match(bad[0], /repository.deploy is required/);
        assert.match(bad.join('\n'), /agent.auth must be/);
        assert.match(bad.join('\n'), /checks\[0\] needs a command/);
        assert.match(bad.join('\n'), /not a regular expression/);
        assert.match(bad.join('\n'), /notify.mqtt.url/);
    });

    test('reads host:port', () => {
        assert.deepEqual(parseListen('127.0.0.1:8091'), {host: '127.0.0.1', port: 8091});
        assert.deepEqual(parseListen(':80'), {host: '0.0.0.0', port: 80});
        assert.throws(() => parseListen('nope'), /host:port/);
    });
});

describe('the checks', () => {
    test('are due by the paths the commits touch', () => {
        const checks = [
            {paths: ['statebridge/'], command: 'a'},
            {paths: ['chat'], command: 'b'},
            {command: 'c'},
            {paths: ['x.txt'], command: 'd'},
        ];
        assert.deepEqual(
            applicable(checks, ['statebridge/lib/x.ts']).map((c) => c.command),
            ['a', 'c'],
        );
        assert.deepEqual(
            applicable(checks, ['chat/a.ts', 'x.txt']).map((c) => c.command),
            ['b', 'c', 'd'],
        );
        assert.deepEqual(
            applicable(checks, ['README.md']).map((c) => c.command),
            ['c'],
        );
        assert.deepEqual(applicable([], ['a']), []);
    });
});

describe('the prompt', () => {
    test('names the workspace, the checks and the operator’s text', () => {
        const p = systemPrompt({
            cwd: '/w',
            main: 'master',
            checks: [{paths: ['s/'], command: 'bun test'}],
            extra: 'House rules.',
        });
        assert.match(p, /clone of a repository at \/w, on a branch made from `master`/);
        assert.match(p, /- bun test {2}\(for changes under s\/\)/);
        assert.match(p, /never to weaken/);
        assert.ok(p.endsWith('House rules.'));
        assert.doesNotMatch(systemPrompt({cwd: '/w', main: 'main'}), /checks run/);
    });

    test('slugs', () => {
        assert.equal(slugify('Fix the Off-by-one in scene_restore!'), 'fix-the-off-by-one-in-scene-restore');
        assert.equal(slugify('   '), 'change');
    });
});

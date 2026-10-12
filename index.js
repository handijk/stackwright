#!/usr/bin/env node
/**
 * stackwright — a coder for a gitops repository.
 *
 * Reads `stackwright.yaml` (STACKWRIGHT_CONFIG, default /config/stackwright.yaml), keeps its clone in
 * STACKWRIGHT_WORKSPACE (/workspace) and its task records in STACKWRIGHT_DATA (/data), and listens on
 * api.listen, STACKWRIGHT_LISTEN or 127.0.0.1:8091.
 */

import fs from 'node:fs';
import path from 'node:path';
import {parse as parseYaml} from 'yaml';
import pkg from './package.json' with {type: 'json'};
import {mergeConfig, parseListen, problems} from './config.js';
import {createApi} from './lib/api.js';
import {Workspace} from './lib/git.js';
import {Notifier} from './lib/notify.js';
import {ClaudeCodeRuntime, applyAuthPin} from './lib/runtime/claude-code.js';
import {Tasks} from './lib/tasks.js';

const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);

const configFile = process.env.STACKWRIGHT_CONFIG ?? '/config/stackwright.yaml';
if (!fs.existsSync(configFile)) {
    console.error(`no configuration at ${configFile}: mount stackwright.yaml there, see the README`);
    process.exit(1);
}
const cfg = mergeConfig(parseYaml(fs.readFileSync(configFile, 'utf-8')) ?? {});
const bad = problems(cfg);
if (bad.length > 0) {
    for (const p of bad) console.error(`${configFile}: ${p}`);
    process.exit(1);
}
const near = (p) => (path.isAbsolute(p) ? p : path.resolve(path.dirname(configFile), p));
const workspaceDir = process.env.STACKWRIGHT_WORKSPACE ?? '/workspace';
const dataDir = process.env.STACKWRIGHT_DATA ?? '/data';
fs.mkdirSync(dataDir, {recursive: true});

applyAuthPin(cfg.agent.auth, process.env, log);
const runtime = new ClaudeCodeRuntime({model: cfg.agent.model, auth: cfg.agent.auth, log});

const workspace = new Workspace({
    dir: workspaceDir,
    deploy: cfg.repository.deploy,
    mirror: cfg.repository.mirror,
    main: cfg.repository.main,
    user: cfg.agent.git,
    log,
});
await workspace.ensure();

const notifier = new Notifier({webhook: cfg.notify.webhook, mqtt: cfg.notify.mqtt, log});
const prompt = cfg.agent.prompt ? fs.readFileSync(near(cfg.agent.prompt), 'utf-8') : '';
const mcpServers = cfg.agent.mcp ? readMcp(near(cfg.agent.mcp)) : {};
const tasks = new Tasks({
    cfg,
    workspace,
    runtime,
    notifier,
    storePath: path.join(dataDir, 'tasks.json'),
    prompt,
    mcpServers,
    log,
});
await tasks.recover();
tasks.publishState();

const {host, port} = parseListen(cfg.api.listen ?? process.env.STACKWRIGHT_LISTEN ?? '127.0.0.1:8091');
createApi({tasks, runtime, pkg, token: cfg.api.token, setupToken: cfg.api.setupToken, log}).listen(port, host, () =>
    log(`${pkg.name} ${pkg.version} listening on ${host}:${port}; credential: ${runtime.authInUse}`),
);

process.on('SIGTERM', async () => {
    log('SIGTERM');
    await notifier.close();
    process.exit(0);
});

/** The MCP servers of a file in Claude Code's format: {mcpServers: {...}} or the map itself. */
function readMcp(file) {
    const doc = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return doc && typeof doc === 'object' && doc.mcpServers ? doc.mcpServers : (doc ?? {});
}

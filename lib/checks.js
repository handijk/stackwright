/** The checks: which ones a set of changed files is due, and running them in the clone. */

import {run} from './git.js';

/** A check without paths is always due; a path `dir/` matches by prefix, a file by equality. */
export function applicable(checks, files) {
    return (checks ?? []).filter((c) => {
        const paths = c.paths ?? [];
        if (paths.length === 0) return true;
        return files.some((f) =>
            paths.some((p) => p === '.' || f === p || f.startsWith(p.endsWith('/') ? p : `${p}/`)),
        );
    });
}

/** Run checks in order with `sh -c`; the first failure ends it: {ok, failed: {command, output}}. */
export async function runChecks(checks, {cwd, timeoutMs = 15 * 60_000, log = () => {}, shell = run} = {}) {
    for (const c of checks) {
        log(`check: ${c.command}`);
        try {
            await shell('sh', ['-c', c.command], {cwd, timeoutMs});
        } catch (err) {
            const output =
                [err.stdout, err.stderr].filter(Boolean).join('\n').split('\n').filter(Boolean).slice(-60).join('\n') ||
                err.message;
            return {ok: false, failed: {command: c.command, output}};
        }
    }
    return {ok: true};
}

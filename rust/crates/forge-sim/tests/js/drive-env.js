// The JS reference drivers' environment: this worktree's tools, a scratch sim dir (never
// data/sim: a route command there would start the router walk build), CAS off.
// POLESTAR_ROOT (default: this worktree), POLESTAR_SIMDIR (else $POLESTAR_JSREF/simdir; required: copies of
// data/sim's world-*.json, params.json, floors.json; symlinks to its walks-*.bin).
const path = require('path');
const t0 = Date.now();
process.on('exit', (c) => console.error(`[drive] exit ${c}, ${((Date.now() - t0) / 1000).toFixed(1)} s, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(0)} MB`));
process.env.POLESTAR_CAS = 'off';
process.env.POLESTAR_CAS_SKIP = 'walks';
const ROOT = process.env.POLESTAR_ROOT || path.resolve(__dirname, '../../../../..');
const SIMDIR = process.env.POLESTAR_SIMDIR || (process.env.POLESTAR_JSREF && path.join(process.env.POLESTAR_JSREF, 'simdir'));
if (!SIMDIR) {
	console.error('usage: POLESTAR_SIMDIR=<scratch sim dir> (or POLESTAR_JSREF=<dir> holding simdir/) node <driver>.js ...');
	process.exit(2);
}
process.chdir(ROOT);
require(ROOT + '/tools/lib/sim').DEFAULTS.simDir = SIMDIR;
module.exports = { ROOT, SIMDIR };

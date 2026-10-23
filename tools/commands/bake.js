'use strict';
// bake: the walks into each step of a guide pack's leveling guides, routed on
// the navigation grid and written beside the guides (tools/lib/nav/bake.js;
// data/local/research/NavArchitecture.md §4.5). compile writes them into the
// race parts; a leg that does not route, or detours without a named passage,
// goes to the QA list instead.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseArgs } = require('../lib/cli');
const { ROOT, DATA } = require('../lib/paths');

const usage = `usage: node tools/polestar.js bake [options]

Routes the walk into every step of the class route guides (a class and a
race header) in the guide folder on the navigation grid, and writes
<dir>/legs.json (each guide's legs as strings, with the grid build and a hash
of the guide's leg ends, so compile leaves out the legs of a guide changed
since) and <dir>/legs-qa.txt (the legs not written: no route, or a detour of
more than 1.5x the straight line without a named passage).

options:
  --guides <dir>   guide sources (default guides/)
  --filter <text>  only guides whose id contains it
  --nav <dir>      navigation grid (default data/local/nav4)
  --data <dir>     reference data (default data/forever/)
  --cache <dir>    routed legs kept across runs, one file per router version
                   (its code and the grid-wide files; default
                   data/local/legcache/): a rebake routes only legs with new
                   ends, another profile, or a changed tile on the way`;

// The navigation router (tools/lib/nav/router.js) for the bake: { route,
// heightAt, fingerprint, tilesOf, tileHash } | null. fingerprint, the leg
// cache's version, is the router's (its code, the grid-wide files, hubs and
// zones) with the bake's own code; the tiles a leg crosses are checked by
// content per leg (tilesOf, tileHash), which the router's fingerprint does not see.
function openRouter(dir) {
	if (!fs.existsSync(path.join(dir, 'index.json'))) return null;
	const r = require('../lib/nav/router').open(dir, {});
	const { cellOf } = require('../lib/nav/grid/format');
	const tileHashes = new Map();
	return {
		route: (a, b, profile) => r.route(a, b, profile),
		heightAt: (c, wx, wy, z) => r.heightAt(c, wx, wy, z),
		fingerprint: crypto.createHash('sha1').update(String(r.fingerprint)).update(fs.readFileSync(path.join(__dirname, '..', 'lib', 'nav', 'bake.js'))).digest('hex').slice(0, 16),
		tilesOf: (c, pts) => {
			const out = new Set();
			for (const [wx, wy] of pts) {
				const cell = cellOf(wx, wy);
				out.add(`${c}:${cell.col}_${cell.row}`);
			}
			return [...out].sort();
		},
		tileHash: (key) => {
			if (!tileHashes.has(key)) {
				const [c, tile] = key.split(':');
				const h = crypto.createHash('sha1');
				for (const ext of ['nav', 'hpa', 'walls']) {
					const file = path.join(dir, 'tiles', c, `${tile}.${ext}.gz`);
					h.update(fs.existsSync(file) ? fs.readFileSync(file) : 'none');
				}
				tileHashes.set(key, h.digest('hex').slice(0, 12));
			}
			return tileHashes.get(key);
		},
	};
}

async function run(argv) {
	const { opts, error } = parseArgs(argv, { options: ['--guides', '--filter', '--nav', '--data', '--cache'] });
	if (error || opts.help) {
		console.log(error ? `${error}\n\n${usage}` : usage);
		return error ? 2 : 0;
	}
	const { buildPack } = require('../lib/pack/build');
	const { commandPack } = require('../lib/pack/locate');
	const { profileFor } = require('../lib/nav/move');
	const bake = require('../lib/nav/bake');
	const dataDir = opts.data ? path.resolve(opts.data) : DATA;
	const dir = path.resolve(opts.guides || path.join(ROOT, 'guides'));
	const navDir = path.resolve(opts.nav || path.join(ROOT, 'data', 'local', 'nav4'));
	const router = openRouter(navDir);
	if (!router) {
		console.error(`no navigation grid at ${navDir}`);
		return 1;
	}
	const r = buildPack(commandPack({ guides: dir }), { dataDir });
	if (r.diag.errors.length) {
		console.error(`the guides do not compile (${r.diag.errors.length} errors): run lint`);
		return 1;
	}
	const guides = r.guides.filter((g) => Array.isArray(g.classes) && g.classes.length && Array.isArray(g.races) && g.races.length && (!opts.filter || g.id.includes(opts.filter)));
	const frames = JSON.parse(fs.readFileSync(path.join(dataDir, 'map-frames.json'), 'utf8'));
	const chokepoints = bake.loadChokepoints(path.join(ROOT, 'addon', 'Polestar_Nav', 'Nav', 'Chokepoints.lua'));
	// The guide's faction (the router keeps clear of its enemies' towns) and class on foot.
	const profileOf = (g) => ({ faction: g.faction || null, move: profileFor({ cls: g.classes[0], level: g.minLevel || 1 }) });
	const cache = new bake.LegCache(path.resolve(opts.cache || path.join(ROOT, 'data', 'local', 'legcache')), router.fingerprint, { tileHash: router.tileHash });
	const out = bake.bakeGuides(guides, { router, frames, chokepoints, profileOf, cache, log: (m) => console.error(m) });
	const file = path.join(dir, 'legs.json');
	// Earlier legs of guides not baked this time are kept.
	const prev = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
	const grid = router.fingerprint;
	const legs = prev && prev.grid === grid ? { ...prev.legs, ...out.legs } : out.legs;
	fs.writeFileSync(file, `${JSON.stringify({ schema: 1, grid, legs }, null, '\t')}\n`);
	fs.writeFileSync(path.join(dir, 'legs-qa.txt'), out.qa.map((q) => `${q.guide}\tstep ${q.step}\t${q.key}\t${q.reason}`).join('\n') + (out.qa.length ? '\n' : ''));
	const s = out.stats;
	console.log(`bake: ${guides.length} guides, ${s.legs} legs (${s.distinct} distinct; ${s.routed} routed, ${s.stale} of them over a changed tile, ${s.cached} from the cache): ${s.baked} baked, ${s.failed} not routed, ${s.detour} detours to QA; ${(s.bytes / 1024).toFixed(0)} KiB of leg strings -> ${path.relative(process.cwd(), file)}`);
	return 0;
}

module.exports = { name: 'bake', summary: 'route the walk into each step of the class route guides (baked legs)', usage, run };

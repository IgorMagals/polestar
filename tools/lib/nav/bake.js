'use strict';
// Baked guide legs (data/local/research/NavArchitecture.md §4.5, phase 1):
// the walk into each step of a compiled guide, routed offline on the
// navigation grid (router.js) and shipped as one string per leg, so the arrow
// follows a known way instead of searching (Nav.BakedLeg in the addon).
//
//   stepTargets(guide, frames) -> [{ s, from, to }]   the legs: step s's first
//     located goal, from the last located goal before it, on one continent
//   bakeGuides(guides, { router, frames, chokepoints, profileOf, cache }) ->
//     (router: tools/lib/nav/router.js's shape, { route(a, b, profile),
//     profile = { faction, move: move.js profileFor() },
//     heightAt(c, wx, wy, nearZ), fingerprint, tilesOf(c, pts)?, tileHash(tile)? };
//     cache: a LegCache, the routed legs of earlier runs)
//     { legs: { [guideId]: { hash, steps: { [s]: string } } }, qa: [...], stats }
//   encodeLeg(leg) / decodeLeg(string)    the leg string (format below)
//   guideHash(guide, frames)              the guide's leg ends, hashed (staleness)
//
// A leg: route from -> to; 3D Douglas-Peucker at SIMPLIFY_YD, never dropping
// a corner where the segment class changes, the height jumps more than
// FLOOR_YD between neighbours (a floor change) or a hop (jump, fall, climb,
// lift) starts or ends; then the ground height every STRIP_YD along it.
// Legs are deduplicated by their ends rounded to a yard. A leg that does not
// route, or runs more than DETOUR times the straight line without passing a
// named chokepoint, is not written: it goes to the QA list.
//
// The string (printable, one Lua literal): base-64 digits (A-Z a-z 0-9 + /),
// each 5 bits of a varint plus a continuation bit (32); signed values
// zigzagged. Fields: version (1), n; per point dx, dy (QXY yd) and dz (QZ yd)
// from the previous one (the first from 0); n-1 segment classes (grid/format.js
// CLS); tail (QZ yd from the last point to the goal); m, then the strip's m
// ground heights (QZ yd, the first from the first point's z, then deltas).

const crypto = require('node:crypto');
const { CLS } = require('./grid/format');

const SIMPLIFY_YD = 4;
const FLOOR_YD = 6;
const STRIP_YD = 2;
const DETOUR = 1.5;
const MIN_LEG_YD = 15;
const PASSAGE_YD = 15;
const QXY = 0.5;
const QZ = 0.25;
const VERSION = 1;
const HOPS = new Set([CLS.JUMP, CLS.FALL, CLS.CLIMB, CLS.LIFT]);

const DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const VALUE = new Map([...DIGITS].map((ch, i) => [ch, i]));

function putVarint(out, v) {
	let u = v;
	do {
		let d = u % 32;
		u = Math.floor(u / 32);
		if (u > 0) d += 32;
		out.push(DIGITS[d]);
	} while (u > 0);
}
const zig = (v) => (v < 0 ? -2 * v - 1 : 2 * v);
const unzig = (u) => (u % 2 ? -(u + 1) / 2 : u / 2);

// The world position of a compiled goal (its own place, else its first
// candidate's, else its first spawn spot's), or null.
function goalWorld(goal, frames) {
	let map = goal.map;
	let x = goal.x;
	let y = goal.y;
	let f = goal.f;
	if ((x == null || y == null) && Array.isArray(goal.candidates) && goal.candidates[0]) ({ map, x, y, f } = goal.candidates[0]);
	if ((x == null || y == null) && Array.isArray(goal.spots) && goal.spots[0]) ({ x, y } = goal.spots[0]);
	if (map == null || x == null || y == null) return null;
	const b = f === 'e' ? frames.era && frames.era[map] : (frames.forever && frames.forever[map]) || (frames.era && frames.era[map]);
	if (!b) return null;
	return { c: b.c, wx: b.top + ((b.bottom - b.top) * y) / 100, wy: b.left + ((b.right - b.left) * x) / 100 };
}

// Step s (1-based, as the addon counts) and its leg in: from the last located
// goal before the step to its first located goal, on one continent and at
// least MIN_LEG_YD apart.
function stepTargets(guide, frames) {
	const out = [];
	let last = null;
	guide.steps.forEach((step, i) => {
		let first = null;
		let end = null;
		for (const goal of step.goals || []) {
			if (goal.t === 'note') continue;
			const p = goalWorld(goal, frames);
			if (!p) continue;
			if (!first) first = p;
			end = p;
		}
		if (first && last && last.c === first.c && Math.hypot(first.wx - last.wx, first.wy - last.wy) >= MIN_LEG_YD) out.push({ s: i + 1, from: last, to: first });
		if (end) last = end;
	});
	return out;
}

function guideHash(guide, frames) {
	const h = crypto.createHash('sha1');
	for (const t of stepTargets(guide, frames)) h.update(`${t.s}:${legKey(t)};`);
	return h.digest('hex').slice(0, 12);
}

const legKey = (t) => `${t.from.c}:${Math.round(t.from.wx)},${Math.round(t.from.wy)}>${Math.round(t.to.wx)},${Math.round(t.to.wy)}`;

// Douglas-Peucker in 3D over points [x, y, z] with segment classes cls (one
// fewer); `fixed` indices are always kept. -> kept indices, in order.
function simplify(pts, cls, tol = SIMPLIFY_YD) {
	const n = pts.length;
	const keep = new Uint8Array(n);
	keep[0] = 1;
	keep[n - 1] = 1;
	for (let i = 1; i < n - 1; i++) {
		if (cls[i - 1] !== cls[i] || HOPS.has(cls[i - 1]) || HOPS.has(cls[i])) keep[i] = 1;
		if (Math.abs(pts[i][2] - pts[i - 1][2]) > FLOOR_YD || Math.abs(pts[i + 1][2] - pts[i][2]) > FLOOR_YD) keep[i] = 1;
	}
	const dist = (p, a, b) => {
		const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
		const ap = [p[0] - a[0], p[1] - a[1], p[2] - a[2]];
		const L = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
		const t = L > 0 ? Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / L)) : 0;
		return Math.hypot(ap[0] - t * ab[0], ap[1] - t * ab[1], ap[2] - t * ab[2]);
	};
	const run = (a, b) => {
		let best = -1;
		let bd = tol;
		for (let i = a + 1; i < b; i++) {
			const d = dist(pts[i], pts[a], pts[b]);
			if (d > bd) {
				bd = d;
				best = i;
			}
		}
		if (best < 0) return;
		keep[best] = 1;
		run(a, best);
		run(best, b);
	};
	let a = 0;
	for (let i = 1; i < n; i++) {
		if (!keep[i]) continue;
		run(a, i);
		a = i;
	}
	const out = [];
	for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
	return out;
}

function encodeLeg({ pts, cls, tail, strip }) {
	const out = [];
	putVarint(out, VERSION);
	putVarint(out, pts.length);
	let px = 0;
	let py = 0;
	let pz = 0;
	for (const [x, y, z] of pts) {
		const qx = Math.round(x / QXY);
		const qy = Math.round(y / QXY);
		const qz = Math.round(z / QZ);
		putVarint(out, zig(qx - px));
		putVarint(out, zig(qy - py));
		putVarint(out, zig(qz - pz));
		px = qx;
		py = qy;
		pz = qz;
	}
	for (const c of cls) putVarint(out, c);
	putVarint(out, Math.round(tail / QZ));
	putVarint(out, strip.length);
	let sz = Math.round(pts[0][2] / QZ);
	for (const z of strip) {
		const q = Math.round(z / QZ);
		putVarint(out, zig(q - sz));
		sz = q;
	}
	return out.join('');
}

function decodeLeg(s) {
	let i = 0;
	const next = () => {
		let v = 0;
		let mul = 1;
		for (;;) {
			const d = VALUE.get(s[i++]);
			v += (d % 32) * mul;
			if (d < 32) return v;
			mul *= 32;
		}
	};
	const version = next();
	if (version !== VERSION) throw new Error(`leg version ${version}`);
	const n = next();
	const pts = [];
	let qx = 0;
	let qy = 0;
	let qz = 0;
	for (let k = 0; k < n; k++) {
		qx += unzig(next());
		qy += unzig(next());
		qz += unzig(next());
		pts.push([qx * QXY, qy * QXY, qz * QZ]);
	}
	const cls = [];
	for (let k = 0; k < n - 1; k++) cls.push(next());
	const tail = next() * QZ;
	const m = next();
	const strip = [];
	let sz = Math.round(pts[0][2] / QZ);
	for (let k = 0; k < m; k++) {
		sz += unzig(next());
		strip.push(sz * QZ);
	}
	return { pts, cls, tail, strip };
}

// The ground every STRIP_YD along the polyline: the grid's surface nearest the
// line's own height there (heightAt), else the line's height.
function stripOf(pts, c, heightAt) {
	const out = [];
	let carry = 0;
	for (let k = 0; k + 1 < pts.length; k++) {
		const a = pts[k];
		const b = pts[k + 1];
		const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
		let t = carry;
		while (t < len) {
			const f = len > 0 ? t / len : 0;
			const x = a[0] + (b[0] - a[0]) * f;
			const y = a[1] + (b[1] - a[1]) * f;
			const z = a[2] + (b[2] - a[2]) * f;
			const h = heightAt(c, x, y, z);
			out.push(Number.isFinite(h) ? h : z);
			t += STRIP_YD;
		}
		carry = t - len;
	}
	return out;
}

// Whether the polyline passes within PASSAGE_YD of a named chokepoint (a
// gate, a bridge, a tunnel, a cave or building mouth, a pass, a lift).
function passesNamed(pts, c, chokepoints) {
	for (const p of chokepoints) {
		if (p.c !== c) continue;
		for (const q of pts) if (Math.hypot(q[0] - p.wx, q[1] - p.wy) <= PASSAGE_YD + (p.r || 0)) return true;
	}
	return false;
}

// Polestar_Nav's chokepoints (Nav/Chokepoints.lua): [{ c, wx, wy, r, kind, name }].
function loadChokepoints(file) {
	const out = [];
	let c = null;
	for (const line of require('node:fs').readFileSync(file, 'utf8').split('\n')) {
		const h = /^PolestarNavChokepoints\[(\d+)\] = \{/.exec(line);
		if (h) c = Number(h[1]);
		const m = /\{ wx = (-?[\d.]+), wy = (-?[\d.]+), z = (-?[\d.]+), r = ([\d.]+), kind = "(\w+)", name = "([^"]*)"/.exec(line);
		if (m && c !== null) out.push({ c, wx: Number(m[1]), wy: Number(m[2]), r: Number(m[4]), kind: m[5], name: m[6] });
	}
	return out;
}

// Route and pack one leg -> { ok, string } | { ok: false, reason }.
// Route one leg and pack it, before the gate -> { ok, string, yards } |
// { ok: false, reason } (no route). What the leg cache keeps.
function routeLeg(t, { router, profile }) {
	const r = router.route({ c: t.from.c, wx: t.from.wx, wy: t.from.wy }, { c: t.to.c, wx: t.to.wx, wy: t.to.wy }, profile);
	if (!r.ok) return { ok: false, reason: r.reason };
	const raw = [];
	for (let k = 0; k < r.pts.length; k += 3) raw.push([r.pts[k], r.pts[k + 1], r.pts[k + 2]]);
	const rawCls = Array.from(r.cls);
	const keep = simplify(raw, rawCls);
	const pts = keep.map((k) => raw[k]);
	// A kept segment's class: the first class of the raw run it stands for.
	const cls = keep.slice(0, -1).map((k) => rawCls[k]);
	const last = pts[pts.length - 1];
	const tail = Math.hypot(t.to.wx - last[0], t.to.wy - last[1]);
	const strip = stripOf(pts, t.from.c, router.heightAt);
	const out = { ok: true, string: encodeLeg({ pts, cls, tail, strip }), yards: r.yards };
	// The grid tiles the walk crosses, by their content (LegCache: an edit
	// of any of them routes the leg again).
	if (router.tilesOf && router.tileHash) out.tiles = Object.fromEntries(router.tilesOf(t.from.c, raw).map((k) => [k, router.tileHash(k)]));
	return out;
}

// The gate on a routed leg: a detour of more than DETOUR times the straight
// line that passes no named chokepoint is not written.
function gateLeg(t, routed, chokepoints) {
	if (!routed.ok) return routed;
	const straight = Math.hypot(t.to.wx - t.from.wx, t.to.wy - t.from.wy);
	if (routed.yards > DETOUR * straight && !passesNamed(decodeLeg(routed.string).pts, t.from.c, chokepoints)) {
		return { ok: false, reason: `detour ${(routed.yards / straight).toFixed(2)}x straight, no named passage`, yards: routed.yards, straight };
	}
	return routed;
}

function bakeLeg(t, { router, profile, chokepoints }) {
	return gateLeg(t, routeLeg(t, { router, profile }), chokepoints);
}

// The cache key of a leg: its ends (a yard) and the profile it is routed
// with; the router's version keys the cache file (LegCache).
function profileKey(profile) {
	return crypto.createHash('sha1').update(JSON.stringify(profile || null)).digest('hex').slice(0, 10);
}

// Routed legs kept across runs: data/local/legcache/<router version>.json,
// key -> routeLeg's result. The version covers the router's code and its
// grid-wide files (another starts a new file); a leg also keeps the content
// hash of each tile it crosses, and is routed again once one of them changed
// (`tileHash`: the router's, for the tile keys routeLeg stored). A change
// elsewhere that would open a shorter way does not reroute it: a grid
// rebuild of the whole map takes a new version. A rebake routes only legs the
// cache lacks or holds stale.
class LegCache {
	constructor(dir, version, { tileHash = null } = {}) {
		this.file = dir ? require('node:path').join(dir, `${String(version).replace(/[^A-Za-z0-9._-]/g, '_')}.json`) : null;
		this.tileHash = tileHash;
		this.stale = 0;
		this.map = new Map();
		this.dirty = false;
		const fs = require('node:fs');
		if (this.file && fs.existsSync(this.file)) {
			try {
				for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8')))) this.map.set(k, v);
			} catch {
				this.map.clear();
			}
		}
	}

	get(k) {
		const v = this.map.get(k);
		if (v && v.tiles && this.tileHash && Object.entries(v.tiles).some(([tile, h]) => this.tileHash(tile) !== h)) {
			this.stale++;
			return undefined;
		}
		return v;
	}

	set(k, v) {
		this.map.set(k, v);
		this.dirty = true;
	}

	save() {
		if (!this.file || !this.dirty) return;
		const fs = require('node:fs');
		fs.mkdirSync(require('node:path').dirname(this.file), { recursive: true });
		fs.writeFileSync(`${this.file}.tmp`, JSON.stringify(Object.fromEntries(this.map)));
		fs.renameSync(`${this.file}.tmp`, this.file);
		this.dirty = false;
	}
}

// Every guide's legs, each distinct (ends, profile) routed once, and not at
// all when `cache` (a LegCache) has it.
function bakeGuides(guides, { router, frames, chokepoints = [], profileOf, cache = new LegCache(null), log = () => {} }) {
	const seen = new Set();
	const legs = {};
	const qa = [];
	const stats = { legs: 0, distinct: 0, routed: 0, cached: 0, stale: 0, baked: 0, failed: 0, detour: 0, bytes: 0 };
	for (const g of guides) {
		const steps = {};
		const profile = profileOf(g);
		const pk = profileKey(profile);
		for (const t of stepTargets(g, frames)) {
			stats.legs++;
			const key = `${legKey(t)}|${pk}`;
			let routed = cache.get(key);
			if (!routed) {
				routed = routeLeg(t, { router, profile });
				cache.set(key, routed);
				stats.routed++;
				if (stats.routed % 200 === 0) {
					log(`${stats.routed} legs routed`);
					cache.save();
				}
			} else if (!seen.has(key)) stats.cached++;
			const res = gateLeg(t, routed, chokepoints);
			if (!seen.has(key)) {
				seen.add(key);
				stats.distinct++;
				if (res.ok) stats.bytes += res.string.length;
				else if (/^detour/.test(res.reason)) stats.detour++;
				else stats.failed++;
			}
			if (res.ok) {
				steps[t.s] = res.string;
				stats.baked++;
			} else qa.push({ guide: g.id, step: t.s, key: legKey(t), reason: res.reason });
		}
		legs[g.id] = { hash: guideHash(g, frames), steps };
	}
	cache.save();
	stats.stale = cache.stale;
	return { legs, qa, stats };
}

module.exports = { loadChokepoints, stepTargets, guideHash, goalWorld, simplify, encodeLeg, decodeLeg, stripOf, passesNamed, routeLeg, gateLeg, bakeLeg, bakeGuides, LegCache, profileKey, SIMPLIFY_YD, STRIP_YD, DETOUR };

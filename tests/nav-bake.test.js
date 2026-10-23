'use strict';
// Baked guide legs (tools/lib/nav/bake.js; addon/Polestar/Nav/Baked.lua):
// B1: a guide's legs are the walks into its steps, from the last located goal
//     before each step to its first, on one continent.
// B2: simplification keeps the corners where the class or the floor changes.
// B3: a leg reads back as written; Nav.BakedLeg decodes the current guide's
//     leg for a step (points, heights, yards left to the goal, classes, the
//     ground strip) and nothing for a step without one.
// B4: a leg that does not route, or detours without a named passage, goes to
//     QA and is not written; through a named passage it is.
// B5: compile writes a guide's legs into its race part (format 6) while its
//     leg ends hash as baked, and leaves them out once the guide changed.
// B6: the decoded leg is Nav.follow.Step's path (Follow.lua's contract).
// B7: the leg cache: a rebake routes only legs with new ends, profile or grid.
// B8: a cached leg over a changed tile is routed again.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const B = require('../tools/lib/nav/bake');
const { runAddon } = require('./helpers/lua');
const { TEST_PACK, TEST_SOURCE } = require('./helpers/packs');
const { tmpdir } = require('./helpers/tmp');
const { DATA_DIR } = require('./helpers/dsl');
const { buildPack } = require('../tools/lib/pack/build');
const { commandPack } = require('../tools/lib/pack/locate');

// One map: wx = -10 * y, wy = -10 * x (map percent -> yards).
const FRAMES = { era: { 1: { c: 0, top: 0, bottom: -1000, left: 0, right: -1000 } } };
const goal = (x, y, t = 'goto') => ({ t, map: 1, x, y, f: 'e' });

test('nav-bake B1: one leg into each step, from the last located goal before it', () => {
	const g = { steps: [
		{ goals: [goal(10, 10), goal(12, 12, 'kill')] },
		{ goals: [{ t: 'note' }, goal(20, 20)] },
		{ goals: [goal(20.5, 20.5)] }, // under MIN_LEG_YD from the last
		{ goals: [goal(40, 30)] },
	] };
	const legs = B.stepTargets(g, FRAMES);
	assert.deepEqual(legs.map((l) => l.s), [2, 4]);
	assert.deepEqual([legs[0].from.wx, legs[0].from.wy, legs[0].to.wx, legs[0].to.wy], [-120, -120, -200, -200]);
});

test('nav-bake B2: simplification keeps class and floor changes', () => {
	const pts = [[0, 0, 0], [10, 0.5, 0], [20, 0, 0], [30, 0.2, 0], [40, 0, 10], [50, 0.1, 10], [60, 0, 10]];
	const cls = [0, 0, 5, 5, 5, 5];
	assert.deepEqual(B.simplify(pts, cls), [0, 2, 3, 4, 6]);
});

const LEG = { pts: [[-100, -200.5, 30], [-150, -260, 32.25], [-151, -300, 40]], cls: [0, 5], tail: 2.5, strip: [30, 30.5, 31.25, 33] };

test('nav-bake B3: a leg reads back; Nav.BakedLeg decodes the current guide\'s leg for a step', () => {
	const s = B.encodeLeg(LEG);
	assert.match(s, /^[A-Za-z0-9+/]+$/);
	assert.deepEqual(B.decodeLeg(s), LEG);
	const out = runAddon({
		stubs: ['stub_world.lua'],
		before: 'stub.world.addMap(1429, { name = "Elwynn Forest", c = 0, left = 1500, right = -1500, top = 500, bottom = -1500 }); stub.world.moveTo(1429, 48, 42)',
		addons: ['Polestar'],
		saved: { Polestar: 'PolestarCharDB = { schema = 1, guide = "test/baked" }' },
		script: `${TEST_PACK}\n${TEST_SOURCE}
Polestar.RegisterGuide({ id = "test/baked", pack = "test", title = "Baked", minLevel = 1, maxLevel = 5,
	legs = { [2] = ${JSON.stringify(s)} },
	steps = {
		{ title = "A", goals = { { t = "goto", map = 1429, x = 50, y = 40, f = "e" } } },
		{ title = "B", goals = { { t = "goto", map = 1429, x = 60, y = 60, f = "e" } } },
	} })
stub.login()
local Nav = Polestar.Nav
local leg = Nav.BakedLeg and Nav.BakedLeg(2)
local function r(v) return math.floor(v * 100 + 0.5) / 100 end
emit(leg and { n = leg.n, xs = leg.xs, ys = leg.ys, zs = leg.zs, cls = leg.cls, strip = leg.strip, m = leg.m, c = leg.c,
	left = { r(leg.left[1]), r(leg.left[2]), r(leg.left[3]) } } or false)
emit(Nav.BakedLeg and Nav.BakedLeg(1) or false)
local id = leg and leg.id
emit({ same = Nav.BakedLeg(2).id == id, set = type(id) == "number" })`,
	}).emitted;
	const r = (v) => Math.round(v * 100) / 100;
	const d2 = r(Math.hypot(1, 40, 7.75) + 2.5);
	assert.deepEqual(out[0], {
		n: 3, xs: [-100, -150, -151], ys: [-200.5, -260, -300], zs: [30, 32.25, 40], cls: [0, 5], strip: [30, 30.5, 31.25, 33], m: 4, c: 0,
		left: [r(d2 + Math.hypot(50, 59.5, 2.25)), d2, 2.5],
	});
	assert.equal(out[1], false, 'a step without a leg: the arrow searches as before');
	assert.deepEqual(out[2], { same: true, set: true }, 'the same leg again keeps its id (no new decode)');
});

test('nav-bake B4: no route or a detour without a named passage goes to QA; a named passage lets it through', () => {
	const g = { id: 'g', steps: [{ goals: [goal(10, 10)] }, { goals: [goal(20, 10)] }, { goals: [goal(30, 10)] }] };
	// 100 yd straight each; the first leg routes round a 300 yd bend, the second fails.
	const router = {
		route: (a, b) => (a.wy === -200 ? { ok: false, reason: 'no path' } : { ok: true, pts: Float32Array.from([a.wx, a.wy, 0, a.wx - 150, a.wy, 0, b.wx, b.wy, 0]), cls: Uint8Array.from([0, 0]), yards: 300 }),
		heightAt: () => NaN,
	};
	const run = (chokepoints) => B.bakeGuides([g], { router, frames: FRAMES, chokepoints, profileOf: () => ({}) });
	const plain = run([]);
	assert.deepEqual(plain.qa.map((q) => [q.step, q.reason.split(' ')[0]]), [[2, 'detour'], [3, 'no']]);
	assert.deepEqual(plain.legs.g.steps, {});
	const gate = run([{ c: 0, wx: -250, wy: -100, r: 6, kind: 'gate', name: 'A Gate' }]);
	assert.deepEqual(Object.keys(gate.legs.g.steps), ['2']);
	assert.equal(gate.stats.failed, 1);
});

test('nav-bake B5: compile writes the legs of an unchanged guide into its race part, format 6; a changed guide goes without', () => {
	const dir = tmpdir('polestar-legs-');
	fs.writeFileSync(path.join(dir, 'pack.json'), JSON.stringify({ id: 'legs', title: 'Legs', author: 'Ann', version: '1.0.0', license: 'CC0-1.0', folder: 'PolestarPack_Legs' }));
	fs.mkdirSync(path.join(dir, 'guides'));
	const text = (x) => `guide legs/human-warrior/01\ntitle Elwynn Forest\nfaction Alliance\nrace Human\nclass Warrior\nlevels 1-10\nzone Elwynn Forest\n\nstep A\n  goto 48,42\n\nstep B\n  goto ${x},50\n`;
	fs.writeFileSync(path.join(dir, 'guides', 'a.guide'), text(60));
	const build = () => buildPack({ ...commandPack({ pack: dir }), contextDir: null }, { dataDir: DATA_DIR });
	const first = build();
	const frames = first.data.mapFrames;
	const g = first.guides[0];
	fs.writeFileSync(path.join(dir, 'legs.json'), JSON.stringify({ schema: 1, grid: 'test', legs: { [g.id]: { hash: B.guideHash(g, frames), steps: { 2: B.encodeLeg(LEG) } } } }));
	const r = build();
	const part = String(r.files['../PolestarPack_Legs_Human/Guides.lua']);
	assert.match(part, /legsGrid = "test",\n\t\t\tlegs = \{ \[2\] = "[A-Za-z0-9+/]+" \}/);
	assert.match(String(r.files['PolestarPack_Legs.toc']), /X-Polestar-Format: 6/);
	fs.writeFileSync(path.join(dir, 'guides', 'a.guide'), text(70));
	const moved = build();
	assert.doesNotMatch(String(moved.files['../PolestarPack_Legs_Human/Guides.lua']), /legs = /);
	assert.ok(moved.diag.list.some((d) => /changed since their legs were baked/.test(d.message)));
});

test('nav-bake B6: the decoded leg is the follower\'s path: Nav.follow.Step aims along it from its start', () => {
	const s = B.encodeLeg({ pts: [[0, 0, 10], [0, -60, 10], [-60, -60, 10], [-60, -120, 10]], cls: [0, 0, 0], tail: 1, strip: [] });
	const out = runAddon({
		stubs: ['stub_world.lua'],
		before: 'stub.world.addMap(1429, { name = "Elwynn Forest", c = 0, left = 1500, right = -1500, top = 500, bottom = -1500 }); stub.world.moveTo(1429, 48, 42)',
		addons: ['Polestar'],
		saved: { Polestar: 'PolestarCharDB = { schema = 1, guide = "test/baked" }' },
		script: `${TEST_PACK}\n${TEST_SOURCE}
Polestar.RegisterGuide({ id = "test/baked", pack = "test", title = "Baked", minLevel = 1, maxLevel = 5,
	legs = { [2] = ${JSON.stringify(s)} },
	steps = {
		{ title = "A", goals = { { t = "goto", map = 1429, x = 50, y = 40, f = "e" } } },
		{ title = "B", goals = { { t = "goto", map = 1429, x = 54, y = 52, f = "e" } } },
	} })
stub.login()
local Nav = Polestar.Nav
local leg = Nav.BakedLeg(2)
local S = {}
Nav.follow.Reset(S)
local ax, ay = Nav.follow.Step(leg.xs, leg.ys, leg.zs, leg.left, leg.n, S, 1, -2, leg.n)
emit({ ax = math.floor(ax + 0.5), ay = math.floor(ay + 0.5), left = math.floor(S.left + 0.5), idx = S.idx })`,
	}).emitted[0];
	// From the start, along the first straight (x 0): the aim lies on it, ahead.
	assert.equal(out.ax, 0);
	assert.ok(out.ay < -2 && out.ay >= -60, `aim y ${out.ay}`);
	assert.equal(out.idx, 2);
	assert.ok(out.left > 170 && out.left < 182, `left ${out.left}`);
});

test('nav-bake B7: the leg cache keeps routed legs across runs by ends, profile and grid: a rebake routes only new legs', () => {
	const dir = tmpdir('polestar-legcache-');
	const g = { id: 'g', steps: [{ goals: [goal(10, 10)] }, { goals: [goal(20, 10)] }, { goals: [goal(30, 10)] }] };
	let calls = 0;
	const router = { route: (a, b) => { calls++; return { ok: true, pts: Float32Array.from([a.wx, a.wy, 0, b.wx, b.wy, 0]), cls: Uint8Array.from([0]), yards: 100 }; }, heightAt: () => NaN };
	const bake = (fingerprint, profile = { faction: 'Horde' }) => B.bakeGuides([g], { router, frames: FRAMES, profileOf: () => profile, cache: new B.LegCache(dir, fingerprint) });
	const first = bake('grid-1');
	assert.equal(calls, 2);
	const again = bake('grid-1');
	assert.equal(calls, 2, 'nothing routed again');
	assert.deepEqual(again.legs, first.legs);
	assert.equal(again.stats.cached, 2);
	bake('grid-1', { faction: 'Alliance' });
	assert.equal(calls, 4, 'another profile routes anew');
	bake('grid-2');
	assert.equal(calls, 6, 'another grid routes anew');
});

test('nav-bake B8: a cached leg is routed again once a tile it crosses changed, and only then', () => {
	const dir = tmpdir('polestar-legtiles-');
	const g = { id: 'g', steps: [{ goals: [goal(10, 10)] }, { goals: [goal(20, 10)] }, { goals: [goal(30, 10)] }] };
	const seen = [];
	const changed = new Set();
	let calls = 0;
	const router = {
		route: (a, b) => { calls++; return { ok: true, pts: Float32Array.from([a.wx, a.wy, 0, b.wx, b.wy, 0]), cls: Uint8Array.from([0]), yards: 100 }; },
		heightAt: () => NaN,
		// One tile per leg, named by where it starts.
		tilesOf: (c, pts) => {
			const k = `t${Math.round(pts[0][1])}`;
			if (!seen.includes(k)) seen.push(k);
			return [k];
		},
		tileHash: (k) => (changed.has(k) ? 'h2' : 'h1'),
	};
	const bake = () => B.bakeGuides([g], { router, frames: FRAMES, profileOf: () => ({}), cache: new B.LegCache(dir, 'v1', { tileHash: router.tileHash }) });
	bake();
	assert.equal(calls, 2);
	bake();
	assert.equal(calls, 2, 'nothing changed: nothing routed');
	changed.add(seen[1]);
	const again = bake();
	assert.equal(calls, 3, 'only the leg over the changed tile');
	assert.equal(again.stats.stale, 1);
	bake();
	assert.equal(calls, 3, 'the rerouted leg is cached with the new tile');
});

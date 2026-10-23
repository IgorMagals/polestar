'use strict';
// Attunements and keys: the builder (tools/lib/codex/attunements.js through
// the journal), the cited goal table (data/codex/attunements.json), the
// runtime's states and guide (addon/Polestar/Dungeons/Attune.lua) in the real
// engine over the stub world, and the Attunement tab (UI/Dungeons.lua) over
// the fake engine of tests/lua/stub_ui.lua.
//
// The synthetic fixture tests/fixtures/codex/dungeons.json (inputs.attunementTable):
//   Wailing Caverns  fang          an attunement, one of two goals: Horde
//                                  90001 Rite of the Serpent (Nara Wildmane, Thunder Bluff,
//                                  to Tonga Runetotem) > 90002 The Serpent's Trial >
//                                  90003 Fang of the Serpent (Friendly with Thunder Bluff);
//                                  Alliance 90004 Fang of the Serpent (Gryan Stoutmantle)
//   The Deadmines    ironclad-a    an Alliance key: 90006 > 90005, which rewards the Ironclad Key
//                    smelting-key  a key Edwin VanCleef drops inside
//   (and `missing`, whose goal no Codex quest has: dropped with a warning)

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runAddon } = require('./helpers/lua');
const { fakeLocale } = require('./helpers/locale');
const { writeCodexPack } = require('./helpers/codex');
const { DATA, needs } = require('./helpers/data');
const { luaValue } = require('../tools/lib/playtest');
const { buildJournal, emitJournal } = require('../tools/lib/codex/journal');
const { isWebCitation } = require('../tools/lib/codex/web');
const { attunementsOf, loadAttunementTable, auditReport } = require('../tools/lib/codex/attunements');

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'codex', 'dungeons.json'), 'utf8'));
const { codex, inputs } = fixture;

let pack;
before(() => {
	pack = writeCodexPack(codex, { extraFiles: emitJournal(buildJournal(inputs, codex)) });
});
after(() => pack && pack.cleanup());

const shape = (a) => a.steps.map((s) => (s.kind === 'quest' ? `${s.id}${s.goal ? '*' : ''}` : `${s.kind}:${s.item.id}`)).join(' > ');

// ---------------------------------------------------------------------------
// Builder and table
// ---------------------------------------------------------------------------

test('the builder walks each goal back through pre and preAny, adds an item goal\'s sources, and warns of goals the Codex lacks', () => {
	const { byKey, warnings } = attunementsOf(codex, { table: inputs.attunementTable });
	assert.deepEqual(warnings, ['missing: goal quest 99999 is not in the Codex']);
	assert.deepEqual(Object.keys(byKey).sort(), ['deadmines', 'wailing-caverns']);
	const [fang] = byKey['wailing-caverns'];
	assert.equal(shape(fang), '90001 > 90002 > 90003* > 90004*');
	assert.deepEqual([fang.kind, fang.need, fang.faction, fang.any, fang.level, fang.item], ['attunement', 'each', null, true, 17, null]);
	const trial = fang.steps[1];
	assert.deepEqual([trial.after, trial.afterAny, trial.start.name, trial.finish.name], [[], [90001], 'Tonga Runetotem', 'Tonga Runetotem']);
	assert.deepEqual(fang.steps[2].rep, { faction: 81, name: 'Thunder Bluff', standing: 5 });
	const [ironclad, smelting] = byKey.deadmines;
	assert.equal(shape(ironclad), '90006 > 90005*');
	assert.deepEqual([ironclad.faction, ironclad.item, ironclad.steps[1].after], ['A', { id: 90010, name: 'Ironclad Key', quality: 1 }, [90006]]);
	assert.equal(shape(smelting), 'drop:90011');
	assert.deepEqual([smelting.steps[0].npc.name, smelting.steps[0].chance, smelting.steps[0].instance, smelting.level], ['Edwin VanCleef', 100, 'deadmines', null]);
});

test('the journal carries the attunements on their pages, counts them, and the pack file writes them with a per-side summary', () => {
	const j = buildJournal(inputs, codex);
	assert.equal(j.meta.counts.attunements, 3);
	assert.deepEqual(j.warnings, ['missing: goal quest 99999 is not in the Codex']);
	assert.equal(j.dungeons['blackmaw-hold'].attunement, undefined);
	const [file] = emitJournal(j);
	assert.match(file.text, /deadmines=\{[^\n]*attune=\{A=2,H=1\}/);
	assert.match(file.text, /\["wailing-caverns"\]=\{[^\n]*attune=\{A=1,H=1\}/);
	assert.match(file.text, /attunement=\{\{/);
	assert.equal(attunementsOf({}, { table: inputs.attunementTable }).warnings.length, 0, 'no instance, no page, no warning');
});

test('the goal table: every entry cites public sources, names a goal or an item, and nothing comes from Attune', () => {
	const t = loadAttunementTable();
	const ids = new Set();
	for (const a of t.attunements) {
		assert.ok(a.key && a.id && a.name, JSON.stringify(a));
		assert.ok(!ids.has(a.id), `duplicate ${a.id}`);
		ids.add(a.id);
		assert.ok(['attunement', 'key', 'item'].includes(a.kind), a.id);
		assert.ok(['each', 'one'].includes(a.need), a.id);
		assert.ok((a.goal || []).every(Number.isInteger) && ((a.goal || []).length || Number.isInteger(a.item)), a.id);
		assert.ok(a.sources.length && a.sources.every((s) => (typeof s === 'string' ? /^https:\/\//.test(s) : isWebCitation(s))), a.id);
		for (const [q, l] of Object.entries(a.links || {})) assert.ok(/^\d+$/.test(q) && l.pre.every(Number.isInteger) && (typeof l.source === 'string' ? /^https:\/\//.test(l.source) : isWebCitation(l.source)), `${a.id} link ${q}`);
		assert.doesNotMatch(JSON.stringify(a), /Attune(?!ment)/i, `${a.id} names Attune`);
	}
	for (const r of t.removed) assert.ok(r.why && r.sources.length, r.id);
	for (const e of t.inside) {
		assert.ok(['npc', 'object'].includes(e.kind) && Number.isInteger(e.id) && e.name && e.instance, JSON.stringify(e));
		assert.ok(e.sources.length && e.sources.every((s) => isWebCitation(s) && s.edition === 'forever'), `${e.kind} ${e.id}`);
		assert.doesNotMatch(JSON.stringify(e), /Attune(?!ment)/i, `${e.kind} ${e.id} names Attune`);
	}
});

const CODEX_FILES = ['quests', 'items', 'npcs', 'objects', 'factions', 'instances'].map((n) => `codex/${n}.json`);

test('with the local Codex: the Onyxia, Blackwing Lair, Naxxramas and Dalaran chains from our quest data and the cited links', { skip: needs(...CODEX_FILES) }, () => {
	const REAL = path.join(DATA, 'codex');
	const read = (n) => JSON.parse(fs.readFileSync(path.join(REAL, `${n}.json`), 'utf8'));
	const real = { quests: read('quests'), items: read('items'), npcs: read('npcs'), objects: read('objects'), factions: read('factions'), instances: read('instances') };
	const { byKey, warnings } = attunementsOf(real);
	assert.deepEqual(warnings, []);
	const get = (key, id) => byKey[key].find((a) => a.id === id);
	assert.equal(shape(get('onyxias-lair', 'drakefire-h')), '4903 > 4941 > 4974 > 6566 > 6567 > 6568 > 6569 > 6570 > 6582 > 6583 > 6584 > 6585 > 6601 > 6602*');
	assert.deepEqual(get('onyxias-lair', 'drakefire-h').steps[11].after, [6582, 6583, 6584], 'the three Tests of Skulls before Axtroz');
	assert.equal(shape(get('city-of-dalaran', 'sewer-key')), '544 > 545 > 93680 > 92434 > 96984*');
	assert.equal(shape(get('blackwing-lair', 'blackhand')), 'drop:18987 > 7761*', 'the Quartermaster drops the letter that starts it');
	assert.equal(shape(get('naxxramas', 'dread-citadel')), '9121* > 9122* > 9123*');
	assert.equal(byKey['blackrock-spire'], undefined, 'Forever removed the Seal of Ascension');
	// Every cited `inside` place is one a chain meets, of an NPC or object
	// that still has no spawn and no Codex instance.
	const used = new Set(Object.values(byKey).flat().flatMap((a) => (a.inside || []).map((e) => `${e.kind}:${e.id}:${e.instance}`)));
	for (const e of loadAttunementTable().inside) {
		assert.ok(used.has(`${e.kind}:${e.id}:${e.instance}`), `${e.name} is in no chain`);
		const rec = (e.kind === 'npc' ? real.npcs : real.objects)[e.id];
		assert.ok(rec && !(rec.spawns || []).length && !rec.instance, `${e.name}: the Codex places it now`);
	}
	assert.deepEqual(get('molten-core', 'core').inside, [{ kind: 'object', id: 179553, instance: 'blackrock-depths' }], 'the Core Fragment, by the Molten Core portal in Blackrock Depths');
});

test('auditReport compares our chains with Attune\'s by their quests', () => {
	const j = buildJournal(inputs, codex);
	const attune = {
		meta: { version: 'test' },
		attunes: [
			{ id: '1', name: 'Wailing Caverns', group: 'RAIDS', faction: 'Horde', steps: [{ id: 1, type: 'Quest', ref: 90001 }, { id: 2, type: 'Quest', ref: 90003 }, { id: 3, type: 'Quest', ref: 77777 }] },
			{ id: '2', name: 'Something else', group: 'MISC', faction: 'Both', steps: [{ id: 1, type: 'Quest', ref: 88888 }] },
			{ id: '3', name: 'Dungeon quests', group: 'DUNGEONS', faction: 'Both', steps: [] },
		],
	};
	const md = auditReport(j, attune, codex, { verdicts: '- Ours is right.' });
	assert.match(md, /## Verdicts\n\n- Ours is right\.\n$/);
	assert.doesNotMatch(auditReport(j, attune, codex, { verdicts: '' }), /## Verdicts/);
	assert.match(md, /^# Attunements: Polestar against Attune/);
	assert.match(md, /\| Wailing Caverns \(RAIDS\) \| Horde \| Wailing Caverns: Fang of the Serpent \| 2 \| 1 \| 2 \|/);
	assert.match(md, /- Only Attune: 77777: not in our Codex/);
	assert.match(md, /- Only ours: The Serpent's Trial \(90002\): a prerequisite of Fang of the Serpent \(90003\)\./);
	assert.match(md, /No attunement of ours matches/);
	assert.doesNotMatch(md, /Dungeon quests/, 'dungeon quest groups are the dungeon audit\'s');
	assert.match(md, /## Ours only[\s\S]*The Deadmines: Ironclad Key/);
	assert.match(md, /## Removed in Forever\n\n- Seal of Ascension/);
});

// ---------------------------------------------------------------------------
// Runtime: states and the guide, in the real engine
// ---------------------------------------------------------------------------

const MAPS = Object.entries(codex.frames)
	.map(([id, f]) => `w.addMap(${id}, { name = ${JSON.stringify(codex.zones[id].name)}, c = ${f.c}, left = ${f.left}, right = ${f.right}, top = ${f.top}, bottom = ${f.bottom} })`)
	.join('\n');
const ADDON = { name: 'Polestar', files: ['Core/Core.xml', 'Lookup/Lookup.xml', 'Dungeons/Dungeons.xml'] };

const LUA = `
local D = Polestar.Dungeons
local function att(key, id) for _, a in ipairs(D.Attunements(key)) do if a.id == id then return a end end end
local function states(key, id)
	local st = D.AttunementState(att(key, id))
	local out = {}
	for i, e in ipairs(st.steps) do out[i] = e.state end
	return { states = out, done = st.done, owned = st.owned or false, goalDone = st.goalDone, next = st.next or false, left = st.left }
end
local function describe(g)
	local out = {}
	for i, s in ipairs(g and g.steps or {}) do
		local verbs = {}
		for j, goal in ipairs(s.goals) do verbs[j] = goal.t .. (goal.quest and (":" .. goal.quest) or goal.item and (":" .. goal.item) or "") end
		out[i] = { title = s.title, goals = table.concat(verbs, " ") }
	end
	return out
end
`;

function run(script, { faction = 'Horde', race = 'Tauren', level = 18, done = [], at = [1413, 50, 40], with: pk = pack } = {}) {
	return runAddon({
		stubs: ['stub_world.lua'],
		before: `${pk.stubLua}
local w = stub.world
${MAPS}
w.level, w.race, w.raceName, w.faction = ${level}, ${JSON.stringify(race)}, ${JSON.stringify(race)}, ${JSON.stringify(faction)}
w.class, w.className = "WARRIOR", "WARRIOR"
w.moveTo(${at.join(', ')})
w.complete(${luaValue(done)})`,
		addons: [ADDON],
		login: true,
		script: `${LUA}\n${script}`,
	}).emitted;
}

test('states: a Horde character walks the serpent chain; the standing gates the last quest; the Alliance goal is not theirs, and done settles it', () => {
	const [fresh, gated, friendly, finished] = run(`
emit(states("wailing-caverns", "fang"))
stub.world.complete({ 90001, 90002 })
emit(states("wailing-caverns", "fang"))
stub.world.setRep(81, "Thunder Bluff", 5)
emit(states("wailing-caverns", "fang"))
stub.world.complete({ 90003 })
emit(states("wailing-caverns", "fang"))`);
	assert.deepEqual(fresh, { states: ['open', 'locked', 'locked', 'na'], done: false, owned: false, goalDone: false, next: 1, left: 3 });
	assert.deepEqual(gated.states, ['done', 'done', 'rep', 'na'], 'Friendly with Thunder Bluff first');
	assert.deepEqual([friendly.states, friendly.next], [['done', 'done', 'open', 'na'], 3]);
	assert.deepEqual([finished.states, finished.done, finished.goalDone, finished.left], [['done', 'done', 'done', 'na'], true, true, 0]);
});

test('states: an Alliance character takes the other goal; a key is done once owned, its chain done without it says so; a dropped key wants its drop', () => {
	const [fang, before, lost, owned, smelting, dropped] = run(`
emit(states("wailing-caverns", "fang"))
emit(states("deadmines", "ironclad-a"))
stub.world.complete({ 90006, 90005 })
emit(states("deadmines", "ironclad-a"))
stub.world.addItem(90010)
emit(states("deadmines", "ironclad-a"))
emit(states("deadmines", "smelting-key"))
stub.world.addItem(90011)
emit(states("deadmines", "smelting-key"))`, { faction: 'Alliance', race: 'Human' });
	assert.deepEqual(fang.states, ['na', 'na', 'na', 'open']);
	assert.deepEqual(before.states, ['open', 'locked']);
	assert.deepEqual([lost.done, lost.goalDone, lost.owned], [false, true, false], 'the chain is behind, the key is not in the bags');
	assert.deepEqual([owned.done, owned.owned], [true, true]);
	assert.deepEqual([smelting.states, smelting.done], [['open'], false]);
	assert.deepEqual([dropped.states, dropped.done], [['done'], true]);
});

test('the guide walks what is left in order and ends at the entrance; it opens in a tab as lookup/attune/<key>:<id>; nothing left builds none', () => {
	const [fresh, later, opened, finished] = run(`
emit(describe(D.AttuneGuide("wailing-caverns", "fang")))
stub.world.complete({ 90001 })
local def = D.AttuneGuide("wailing-caverns", "fang")
local last = def.steps[#def.steps]
emit({ title = def.title, steps = describe(def), goto = { last.goals[2].map, last.goals[2].x, last.goals[2].y, last.goals[2].text }, note = last.goals[1].text })
local gid = D.Attune("wailing-caverns", "fang")
local tabs = {}
for i, t in ipairs(Polestar.Engine.GetTabs()) do tabs[i] = t.guideId end
emit({ gid = gid, tabs = tabs })
stub.world.complete({ 90002, 90003 })
local none, why = D.AttuneGuide("wailing-caverns", "fang")
emit({ none = none == nil, why = why })`);
	assert.deepEqual(fresh, [
		{ title: 'Rite of the Serpent', goals: 'accept:90001 turnin:90001' },
		{ title: "The Serpent's Trial", goals: 'accept:90002 collect:90002 turnin:90002' },
		{ title: 'Fang of the Serpent', goals: 'accept:90003 turnin:90003' },
		{ title: 'Wailing Caverns', goals: 'note goto' },
	], 'the Alliance goal is not in a Horde guide');
	assert.equal(later.title, 'Wailing Caverns: Fang of the Serpent');
	assert.deepEqual(later.steps.map((s) => s.title), ["The Serpent's Trial", 'Fang of the Serpent', 'Wailing Caverns']);
	assert.deepEqual(later.goto, [1413, 46, 36.4, 'Enter Wailing Caverns']);
	assert.equal(later.note, "Lets you take the serpent's path.");
	assert.deepEqual(opened, { gid: 'lookup/attune/wailing-caverns:fang', tabs: ['lookup/attune/wailing-caverns:fang'] });
	assert.deepEqual(finished, { none: true, why: 'done' });
});

test('a dropped key\'s guide collects it from its NPC at the instance\'s entrance; owned, there is nothing to do', () => {
	const [guide, owned] = run(`
local def = D.AttuneGuide("deadmines", "smelting-key")
local g = def.steps[1].goals[1]
emit({ steps = describe(def), at = { g.map, g.x, g.y, g.npcName }, note = def.steps[1].goals[2].text })
stub.world.addItem(90011)
local none, why = D.AttuneGuide("deadmines", "smelting-key")
emit({ none = none == nil, why = why })`, { faction: 'Alliance', race: 'Human' });
	assert.deepEqual(guide.steps, [
		{ title: 'Smelting Key', goals: 'collect:90011 note' },
		{ title: 'The Deadmines', goals: 'note goto' },
	]);
	assert.deepEqual(guide.at, [1436, 42.5, 71.7, 'Edwin VanCleef']);
	assert.equal(guide.note, 'Edwin VanCleef drops it inside The Deadmines.');
	assert.deepEqual(owned, { none: true, why: 'done' });
});

// The serpent's heart: Tonga sends you into the caverns to the Deviate Keeper,
// who has no spawn; the table's cited `inside` places him and the scale pile
// there, the Codex places Kresh. Above the level 18 character's level.
function heartFixture() {
	const c = structuredClone(codex);
	const quest = (id, title, start, end, objectives, pre) => ({ id, title, level: 26, minLevel: 25, faction: null, races: null, classes: null,
		start: { npc: [start], object: [], item: [] }, end: { npc: [end], object: [] }, objectives, pre, preAny: [], rewards: [], choices: [] });
	c.npcs[90040] = { id: 90040, name: 'Deviate Keeper', level: 22, levelMax: null, faction: null, rare: false, elite: false, boss: false, instance: null, roles: [], spawns: [] };
	c.objects[90050] = { id: 90050, name: 'Glowing Scale Pile', treasure: false, spawns: [] };
	c.items[90031] = { id: 90031, name: 'Shimmering Scale', quality: 1, kind: 'item', spell: null, reqLevel: null, sources: [{ type: 'object', object: 90050, chance: 100 }] };
	c.quests[90030] = quest(90030, 'Into the Caverns', 3448, 90040, [{ type: 'kill', id: 3653, count: 1, text: 'Kresh' }, { type: 'item', id: 90031, count: 1, text: 'Shimmering Scale' }], []);
	c.quests[90032] = quest(90032, 'Heart of the Serpent', 90040, 3448, [], [90030]);
	const table = structuredClone(inputs.attunementTable);
	table.attunements.push({ key: 'wailing-caverns', id: 'heart', name: 'Heart of the Serpent', kind: 'attunement', need: 'each', goal: [90032], note: 'Opens the heart.' });
	table.inside = [
		{ kind: 'npc', id: 90040, name: 'Deviate Keeper', instance: 'wailing-caverns', sources: ['synthetic'] },
		{ kind: 'object', id: 90050, name: 'Glowing Scale Pile', instance: 'wailing-caverns', sources: ['synthetic'] },
		{ kind: 'npc', id: 90041, name: 'Not in the chain', instance: 'wailing-caverns', sources: ['synthetic'] },
	];
	return { codex: c, inputs: { ...inputs, attunementTable: table } };
}

test('a quest whose turn-in, targets or chest are inside an instance stays whole in the guide, at the entrance, and the engine walks every quest; an accept above the level says from which', () => {
	const heart = heartFixture();
	const { byKey } = attunementsOf(heart.codex, { table: heart.inputs.attunementTable });
	assert.deepEqual(byKey['wailing-caverns'].find((a) => a.id === 'heart').inside, [
		{ kind: 'npc', id: 90040, instance: 'wailing-caverns' },
		{ kind: 'object', id: 90050, instance: 'wailing-caverns' },
	], 'only the table\'s entries the chain meets');
	assert.equal(byKey['wailing-caverns'].find((a) => a.id === 'fang').inside, null);
	const pk = writeCodexPack(heart.codex, { extraFiles: emitJournal(buildJournal(heart.inputs, heart.codex)) });
	try {
		const [built, walk] = run(`
local def = D.AttuneGuide("wailing-caverns", "heart")
local at = {}
for i, s in ipairs(def.steps) do
	local g = {}
	for j, goal in ipairs(s.goals) do g[j] = goal.map and table.concat({ goal.map, goal.x, goal.y }, " ") or false end
	at[i] = g
end
local notes = {}
for i, s in ipairs(def.steps) do notes[i] = s.note or false end
emit({ steps = describe(def), at = at, notes = notes })
local E = Polestar.Engine
D.Attune("wailing-caverns", "heart")
stub.advance(0.6)
local walk = {}
local function look()
	local v = E.GetStepView(1)
	walk[#walk + 1] = { step = E.GetStepIndex() or false, accept = v.goals[1].detail }
end
look()
stub.world.setLevel(25)
stub.advance(0.6)
look()
stub.world.accept(90030, { { required = 1 }, { required = 1 } })
stub.world.finish(90030)
stub.world.turnIn(90030)
stub.advance(0.6)
look()
stub.world.accept(90032, {})
stub.world.finish(90032)
stub.world.turnIn(90032)
stub.advance(0.6)
look()
emit(walk)`, { with: pk });
		assert.deepEqual(built.steps, [
			{ title: 'Into the Caverns', goals: 'accept:90030 kill:90030 collect:90030 turnin:90030' },
			{ title: 'Heart of the Serpent', goals: 'accept:90032 turnin:90032' },
			{ title: 'Wailing Caverns', goals: 'note goto' },
		], 'both quests whole, not "First do the quest" notes the engine passes as done');
		const entrance = '1413 46 36.4';
		assert.deepEqual(built.at[0], ['1413 52.2 31.9', entrance, entrance, entrance], 'Tonga in the Barrens; Kresh, the scale pile and the Keeper at the entrance');
		assert.deepEqual(built.at[1], [entrance, '1413 52.2 31.9']);
		assert.deepEqual(built.notes, ['Deviate Keeper, Kresh, Shimmering Scale: inside Wailing Caverns.', 'Deviate Keeper: inside Wailing Caverns.', false]);
		assert.deepEqual(walk, [
			{ step: 1, accept: 'from Tonga Runetotem, from level 25' },
			{ step: 1, accept: 'from Tonga Runetotem' },
			{ step: 2, accept: 'from Tonga Runetotem' },
			{ step: 3, accept: 'from Tonga Runetotem' },
		], 'the guide stays on the gated quest, then walks each quest in turn to the entrance');
	} finally {
		pk.cleanup();
	}
});

test('the other side\'s attunement builds no guide', () => {
	const heart = heartFixture();
	heart.inputs.attunementTable.attunements.push({ key: 'wailing-caverns', id: 'heart-a', name: 'Heart of the Serpent', kind: 'attunement', need: 'each', faction: 'A', goal: [90032] });
	const pk = writeCodexPack(heart.codex, { extraFiles: emitJournal(buildJournal(heart.inputs, heart.codex)) });
	try {
		const [other, mine] = run(`
local none, why = D.AttuneGuide("wailing-caverns", "heart-a")
emit({ none = none == nil, why = why })
emit({ some = D.AttuneGuide("wailing-caverns", "heart") ~= nil })`, { with: pk });
		assert.deepEqual(other, { none: true, why: 'nothing' });
		assert.deepEqual(mine, { some: true });
	} finally {
		pk.cleanup();
	}
});

// ---------------------------------------------------------------------------
// The Attunement tab
// ---------------------------------------------------------------------------

const UI_FILES = ['Core/Core.xml', 'Theme/Theme.xml', 'Gear/Gear.xml', 'Lookup/Lookup.xml', 'Dungeons/Dungeons.xml', 'UI/UI.xml'];

function runUI(script, { locale = '' } = {}) {
	return runAddon({
		stubs: ['stub_ui.lua'],
		before: `${pack.stubLua}\n${locale}`,
		addons: [{ name: 'Polestar', files: UI_FILES }],
		script: `uistub.install()
stub.login()
uistub.player.level, uistub.player.race, uistub.player.class, uistub.player.faction = 18, "Tauren", "WARRIOR", "Horde"
local done, log = {}, {}
Polestar.Compat.IsQuestCompleted = function(id) return done[id] or false end
Polestar.Compat.IsOnQuest = function(id) return log[id] or false end
Polestar.Compat.IsQuestReadyForTurnIn = function() return false end
local DS = Polestar.UI.DungeonsSection
local function plain(s) return (s or ""):gsub("|c%x%x%x%x%x%x%x%x", ""):gsub("|r", "") end
local function rows()
	local out = {}
	for _, r in ipairs(DS.attSteps) do if r:IsShown() then out[#out + 1] = { plain(r.Text:GetText()), plain(r.Sub:GetText()), r.psPoint and true or false } end end
	return out
end
local function tabs()
	local out = {}
	for _, t in ipairs(PolestarPicker.tabButtons) do if t:IsShown() then out[#out + 1] = t.Label:GetText() end end
	return out
end
${script}`,
	}).emitted;
}

test('the Attunement tab: the head with its facts and note, a row per step of this side with its state, and "Guide me through it" opening the guide', () => {
	const [first, progress, deadmines] = runUI(`
Polestar.Dungeons.Open("wailing-caverns")
DS.SetTab("attune")
local h = DS.atts[1]
emit({ tab = DS.Tab(), tabs = tabs(), title = h.Title:GetText(), meta = h.Meta:GetText(), note = h.Note:GetText(), chip = h.State:IsShown(),
	guide = h.Guide:IsShown(), tip = h.Guide.psTipLines, rows = rows(), shown = DS.Shown().attune })
done[90001] = true
log[90002] = true
DS.Render()
local asked = {}
Polestar.Dungeons.Attune = function(key, id) asked[#asked + 1] = key .. ":" .. id return "lookup/attune/" .. key .. ":" .. id end
h.Guide:Click()
emit({ chip = h.State.Text:GetText(), rows = rows(), asked = asked, hub = PolestarPicker:IsShown() })
Polestar.Dungeons.Open("deadmines")
local tabsDm = tabs()
DS.SetTab("attune")
emit({ tabs = tabsDm, heads = { DS.atts[1].Title:GetText(), DS.atts[2] and DS.atts[2]:IsShown() or false }, rows = rows(), owned = DS.atts[1].Owned:GetText() })`);
	assert.equal(first.tab, 'attune');
	assert.deepEqual(first.tabs, ['Quests  4', 'Attunement', 'Bosses  4', 'Map']);
	assert.equal(first.title, 'Fang of the Serpent');
	assert.equal(first.meta, 'Attunement  \u00b7  Everyone entering needs it  \u00b7  From level 17');
	assert.equal(first.note, "Lets you take the serpent's path.");
	assert.deepEqual([first.chip, first.guide], [false, true]);
	assert.deepEqual(first.tip, ['A guide through the 3 steps left, from where you stand.', 'It opens in a new tab.']);
	assert.deepEqual(first.rows, [
		['Rite of the Serpent', 'Nara Wildmane  \u00b7  Thunder Bluff', true],
		["The Serpent's Trial", 'After the steps before it  \u00b7  Tonga Runetotem  \u00b7  The Barrens', true],
		['Fang of the Serpent', 'After the steps before it  \u00b7  Tonga Runetotem  \u00b7  The Barrens', true],
	], 'the Horde filter hides the Alliance goal');
	assert.deepEqual(first.shown, [{ id: 'fang', done: false, guide: true, states: ['open', 'locked', 'locked'] }]);
	assert.equal(progress.chip, '1 of 3 done');
	assert.deepEqual(progress.rows.map((r) => r[1].split('  \u00b7  ')[0]), ['Done', 'In your log', 'After the steps before it']);
	assert.deepEqual([progress.asked, progress.hub], [['wailing-caverns:fang'], false], 'the guide opens and the hub steps aside');
	assert.deepEqual(deadmines.tabs, ['Quests', 'Keys', 'Bosses  1', 'Map'], 'the Horde sees the side-free key only: "Keys"');
	assert.deepEqual(deadmines.heads, ['Smelting Key', false]);
	assert.deepEqual(deadmines.rows, [['Smelting Key from Edwin VanCleef', '100% chance  \u00b7  inside The Deadmines', false]]);
	assert.equal(deadmines.owned, 'Not in your bags or bank');
});

test('the Attunement tab: the kind beside the title is in the client language', () => {
	const [meta] = runUI(
		`
Polestar.Dungeons.Open("wailing-caverns")
DS.SetTab("attune")
emit(DS.atts[1].Meta:GetText())`,
		{ locale: fakeLocale('itIT', { Attunement: 'Zugangsquest', 'Everyone entering needs it': 'Jeder braucht sie', 'From level %d': 'Ab Stufe %d' }) },
	);
	assert.equal(meta, 'Zugangsquest  \u00b7  Jeder braucht sie  \u00b7  Ab Stufe 17');
});

// JS reference for forge sim parity A: the v2 route's own actions as v1 events (accept,
// complete at a quest's first work action, turn-in, grind -> a level checkpoint), replayed on the
// v1 evaluator (the gate's model), walks off or on. node v2events.js <route.json> <off|on> <out.json>
const { ROOT, SIMDIR } = require('./drive-env');
const fs = require('fs');
const [routeFile, walksMode, out] = process.argv.slice(2);
(async () => {
	const doc = JSON.parse(fs.readFileSync(routeFile, 'utf8'));
	const sim = require(ROOT + '/tools/lib/sim/index');
	const { compileSequence } = require(ROOT + '/tools/lib/sim/sequence');
	const { K_GRIND } = require(ROOT + '/tools/lib/sim/run');
	const { LEVEL_XP } = require(ROOT + '/tools/lib/game/xp');
	const { world } = await sim.loadWorld({ faction: doc.faction, simDir: SIMDIR, offline: true, walks: walksMode === 'on', log: (m) => console.error(m) });
	const { mean } = sim.paramsFor(SIMDIR, null);
	const { run, ev } = sim.makeRun(world, { race: doc.race, cls: null, params: mean, family: 'solo' });
	const qid = (a) => doc.questIds[a.quest];
	const events = [];
	const worked = new Set();
	doc.actions.forEach((a, i) => {
		if (a.act === 'accept') events.push({ a: i, t: 'accept', q: qid(a) });
		else if (a.act === 'turnin') events.push({ a: i, t: 'turnin', q: qid(a) });
		else if (['farm', 'use', 'event', 'buy'].includes(a.act) && a.quest != null && a.quest >= 0) {
			const q = qid(a);
			if (!worked.has(q)) { worked.add(q); events.push({ a: i, t: 'complete', q }); }
		} else if (a.act === 'grind') events.push({ a: i, t: 'level', level: a.level });
	});
	const kind = [], qq = [], task = [], pt = [], eOf = [];
	events.forEach((e, k) => {
		const s = compileSequence(run, [e]);
		for (let j = 0; j < s.kind.length; j++) { kind.push(s.kind[j]); qq.push(s.q[j]); task.push(s.task[j]); pt.push(s.pt[j]); eOf.push(k); }
	});
	ev.reset();
	const lvlNow = () => ev.level + (ev.level < 60 ? ev.xp / LEVEL_XP[ev.level] : 0);
	const per = [];
	let si = 0;
	events.forEach((e, k) => {
		while (si < kind.length && eOf[si] === k) {
			if (kind[si] === K_GRIND) ev.grindTo(qq[si], task[si]);
			else ev.step(kind[si], qq[si], task[si], pt[si]);
			si++;
		}
		per.push([+lvlNow().toFixed(6), +ev.time.toFixed(4)]);
	});
	const atEnd = { time: ev.time, level: lvlNow(), questsDone: ev.questsDone, steps: ev.steps };
	ev.finish();
	const res = ev.result();
	fs.writeFileSync(out, JSON.stringify({ faction: doc.faction, race: doc.race, walks: walksMode, v2Hours: doc.hours, v2Actions: doc.actions.length, events, per, atEnd, hours60: res.seconds / 3600, levelTimes: res.levelTimes, result: res }));
	console.error(`${doc.faction} ${doc.race} v2 route (${doc.hours.toFixed(2)} h in v2's model, ${doc.actions.length} actions) as ${events.length} events, walks ${walksMode}: v1 model ${(res.seconds / 3600).toFixed(2)} h to 60, ${(res.levelTimes[30] / 3600).toFixed(2)} h to 30, steps ${atEnd.steps}`);
})().catch((e) => { console.error(e); process.exit(1); });

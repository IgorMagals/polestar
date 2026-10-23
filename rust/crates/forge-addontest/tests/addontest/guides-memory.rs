//! What the compiled guide pack costs in memory: addon/Polestar_Guides/Guides.lua loaded under the test
//! interpreter with a host that only keeps what RegisterGuide hands over, weighed with collectgarbage("count")
//! after a full collect. The pack is in the repository, so this needs no reference data and no game.
//!
//! The budget guards the resident cost against a structural regression (a goal key added to every goal, a
//! table kept per step where one per guide would do). It is not a figure to compare across machines: Lua 5.1
//! and LuaJIT account for tables differently (the same pack weighs about 26.1 MiB under Lua 5.1 and about
//! 18.2 MiB under LuaJIT), so the budget leaves room for the larger of the two plus the guides still to come.
//! Issue #60.

use forge_addontest::run::{addons_dir, root};
use forge_addontest::{emitted, lua_string, run_addon_output, Addon, RunAddon};
use std::path::PathBuf;

fn pack() -> PathBuf {
	root().join("addon").join("Polestar_Guides").join("Guides.lua")
}

fn pack_dir() -> PathBuf {
	addons_dir().join("Polestar_Guides")
}

/// Whether the compiled pack is absent (the tests skip then, saying why).
fn skip() -> bool {
	if pack().exists() {
		return false;
	}
	eprintln!("skipped: addon/Polestar_Guides/Guides.lua not compiled (node tools/polestar.js compile)");
	true
}

const WEIGH: &str = r#"
local kept = {}
Polestar = { RegisterGuide = function(def) kept[def.id] = def end }

collectgarbage("collect"); collectgarbage("collect")
local base = collectgarbage("count")
-- The peak: what loading allocates before any collection (the client's
-- incremental collector lags a load like this one).
collectgarbage("stop")
assert(loadfile(__PACK__))("Polestar_Guides", {})
local peak = collectgarbage("count") - base
collectgarbage("restart")
collectgarbage("collect"); collectgarbage("collect")
local all = collectgarbage("count") - base

local function tally()
	local guides, steps, goals = 0, 0, 0
	for _, def in pairs(kept) do
		guides = guides + 1
		for _, step in ipairs(def.steps or {}) do
			steps = steps + 1
			goals = goals + #(step.goals or {})
		end
	end
	return guides, steps, goals
end
local guides, steps, goals = tally()

-- Guides per faction, the factionless ones counted on their own.
local sides = {}
for _, def in pairs(kept) do
	local side = def.faction or "none"
	sides[side] = (sides[side] or 0) + 1
end

for id, def in pairs(kept) do
	if (def.faction or "none") == __DROP__ then kept[id] = nil end
end
collectgarbage("collect"); collectgarbage("collect")
local ownSide = collectgarbage("count") - base
local keptGuides = tally()

print(string.format("%d %d %d %d %d %d %.1f %.1f %d %.1f",
	guides, steps, goals, sides.none or 0, sides.Alliance or 0, sides.Horde or 0, all, ownSide, keptGuides, peak))
"#;

struct Weight {
	guides: i64,
	steps: i64,
	goals: i64,
	none: i64,
	alliance: i64,
	horde: i64,
	all: f64,
	own_side: f64,
	kept_guides: i64,
	peak: f64,
}

// Resident KiB of the pack, and its guides, steps and goals, per faction. `drop`: a faction whose guides are
// released before the second weighing, for the share a character of the other side would carry.
fn weigh(drop: &str) -> Weight {
	let prog = WEIGH.replace("__PACK__", &lua_string(&pack().to_string_lossy())).replace("__DROP__", &lua_string(drop));
	let out = run_addon_output(&RunAddon { script: prog, ..Default::default() }).unwrap_or_else(|e| panic!("{e}"));
	let line = out.stdout.trim().lines().last().unwrap_or("").to_string();
	let f: Vec<&str> = line.split(' ').collect();
	assert_eq!(f.len(), 10, "unexpected output: {}", out.stdout);
	let int = |i: usize| f[i].parse::<i64>().unwrap_or_else(|e| panic!("bad number {}: {e}", f[i]));
	let num = |i: usize| f[i].parse::<f64>().unwrap_or_else(|e| panic!("bad number {}: {e}", f[i]));
	Weight { guides: int(0), steps: int(1), goals: int(2), none: int(3), alliance: int(4), horde: int(5), all: num(6), own_side: num(7), kept_guides: int(8), peak: num(9) }
}

// Headroom over Lua 5.1's reading of the pack as it stands, for the guides still to come. Lower it when a
// change brings the resident cost down. Repeated candidate lists shared inside a guide (#574): 27.7 -> 23.4 MiB
// resident under Lua 5.1, about 38 MiB at the peak of the load.
const BUDGET_KIB: f64 = 24.5 * 1024.0;
const PEAK_BUDGET_KIB: f64 = 40.0 * 1024.0;

#[test]
fn the_compiled_guide_pack_loads_within_its_memory_budget() {
	if skip() {
		return;
	}
	let m = weigh("Horde");
	assert!(m.guides > 200, "only {} guides registered", m.guides);
	assert!(m.goals > 10000, "only {} goals", m.goals);
	assert!(m.all <= BUDGET_KIB, "resident {:.1} MiB over the {} MiB budget", m.all / 1024.0, BUDGET_KIB / 1024.0);
	assert!(m.peak <= PEAK_BUDGET_KIB, "peak {:.1} MiB over the {} MiB budget", m.peak / 1024.0, PEAK_BUDGET_KIB / 1024.0);
	println!("guides pack: {} guides, {} steps, {} goals, resident {:.1} MiB, peak {:.1} MiB under Lua 5.1 (in-process)", m.guides, m.steps, m.goals, m.all / 1024.0, m.peak / 1024.0);
}

// Issue #60: a character carries its own faction's guides and the factionless ones; the other side's are dead
// weight until the player browses them. This measures what that share is worth, so a change that builds one
// side only can be held to it.
#[test]
fn the_pack_splits_by_faction_so_one_side_plus_the_factionless_guides_is_the_smaller_part() {
	if skip() {
		return;
	}
	let horde = weigh("Horde");
	let alliance = weigh("Alliance");
	assert!(horde.none > 0 && horde.alliance > 0 && horde.horde > 0, "every side should have guides");
	assert_eq!(horde.none + horde.alliance + horde.horde, horde.guides);
	for (side, m) in [("Alliance", &horde), ("Horde", &alliance)] {
		assert!(m.own_side < m.all, "{side}: dropping the other side freed nothing");
		// The bound is loose on purpose, well above the share today: it is the composition of the pack that is
		// being pinned, not a machine's byte count.
		assert!(m.own_side <= m.all * 0.7, "{side}: own side is {:.0} % of the pack, over 70 %", m.own_side / m.all * 100.0);
		println!("guides pack, {side} character: {} of {} guides, resident {:.1} of {:.1} MiB", m.kept_guides, m.guides, m.own_side / 1024.0, m.all / 1024.0);
	}
	println!("guides pack by faction: {} factionless, {} Alliance, {} Horde", horde.none, horde.alliance, horde.horde);
}

// Issue #60, the load-time spike: registering a guide runs Guides.Validate over every step and goal. The key
// lists those checks walk used to be table literals inside their loops, so each of the pack's ~12,000 goals
// left a few throwaway tables behind (about 3 MiB over a full registration). They are one shared table now
// (`KEYS` in Core/Guides.lua), and validating allocates almost nothing.
//
// Measured here on the validation alone, with the pack already loaded, so the figure is not buried under what
// the Lua parser allocates for a 5.6 MB source file. Before the change: 0.267 KiB per goal under Lua 5.1 and
// 0.243 under LuaJIT. After: 0.000 and 0.011.
const MAX_VALIDATE_KIB_PER_GOAL: f64 = 0.05;

#[test]
fn validating_the_registered_guides_allocates_almost_nothing_per_goal() {
	if skip() {
		return;
	}
	let out = emitted(&RunAddon {
		stubs: vec!["stub_world.lua"],
		// The pack by its TOC, the way the client loads it, so a file added to it is measured and cannot make
		// this test and the compiled-pack ones disagree.
		addons: vec![Addon::files("Polestar", &["Core/Core.xml"]), Addon::dir("Polestar_Guides", pack_dir())],
		script: r#"
			local defs, goals = {}, 0
			for _, header in ipairs(Polestar.Guides.List()) do
				local g = Polestar.Guides.Get(header.id)
				if g then
					defs[#defs + 1] = g
					for _, step in ipairs(g.steps) do goals = goals + #step.goals end
				end
			end
			-- Nothing is freed while the collector is stopped, so what the
			-- validation allocates is what it would have left as garbage.
			collectgarbage("collect"); collectgarbage("collect")
			collectgarbage("stop")
			local base = collectgarbage("count")
			for i = 1, #defs do assert(Polestar.Guides.Validate(defs[i]) == nil) end
			local allocated = collectgarbage("count") - base
			collectgarbage("restart")
			emit({ kib = allocated, guides = #defs, goals = goals })
		"#
		.into(),
		..Default::default()
	});
	let m = &out[0];
	let guides = m["guides"].as_f64().unwrap_or(0.0);
	let goals = m["goals"].as_f64().unwrap_or(0.0);
	let kib = m["kib"].as_f64().unwrap_or(0.0);
	assert!(guides > 200.0, "only {} guides registered", m["guides"]);
	assert!(goals > 10000.0, "only {} goals", m["goals"]);
	let per_goal = kib / goals;
	assert!(per_goal <= MAX_VALIDATE_KIB_PER_GOAL, "{per_goal:.3} KiB per goal over the {MAX_VALIDATE_KIB_PER_GOAL} KiB budget");
	println!("guides pack: validating {} goals allocates {:.2} MiB, {per_goal:.3} KiB per goal under Lua 5.1 (in-process)", m["goals"], kib / 1024.0);
}

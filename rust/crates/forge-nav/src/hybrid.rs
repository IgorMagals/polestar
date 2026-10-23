//! The hybrid walks (`--nav hybrid`): Leffe's navigation maps first, our walking grid where his maps fall short.
//! Two walks documents of one world (the grid's and Leffe's, each built from its own store) are merged walk by
//! walk: Leffe's answer is taken when it exists and costs at most `slack` × the grid's (both cost models price a
//! yard alike: seconds × the same ground, hub and danger multipliers, ~1.02-1.05 per yard on the acceptance walks);
//! else the grid's (his pack has no lift arcs and leaves some city parts unjoined, so his way there is a detour or
//! none). Every walk records which backend answered (counts in the stats; the base walks' list in `backend`).

use crate::lookup::WalksDoc;
use crate::walkdoc::Doc;
use rustc_hash::{FxHashMap, FxHashSet};
use serde_json::json;

/// Leffe's walk is kept while it costs at most this many times the grid's.
pub const SLACK: f64 = 1.2;

#[derive(Clone, Copy)]
struct W {
	yd: f64,
	cost: f64,
	/// The pair's index in its document (zone shares of base walks).
	k: usize,
	both: bool,
}

fn directed(p: &[f64]) -> FxHashMap<(u32, u32), W> {
	let mut m = FxHashMap::default();
	for (k, e) in p.chunks_exact(5).enumerate() {
		let (a, b) = (e[0] as u32, e[1] as u32);
		let w = W { yd: e[2], cost: e[3], k, both: e[4] == 0.0 };
		m.insert((a, b), w);
		if w.both {
			m.insert((b, a), w);
		}
	}
	m
}

/// Per band and backend: walks taken from the grid (`grid`), from Leffe (`leffe`), and among the grid's those his
/// maps had no way for (`leffeNone`) or a way over the slack (`leffeDetour`).
pub fn merge(grid: &WalksDoc, leffe: &WalksDoc, slack: f64) -> Result<(Doc, serde_json::Value), String> {
	if grid.header.get("dataHash") != leffe.header.get("dataHash") || grid.header.get("nw") != leffe.header.get("nw") {
		return Err("hybrid: the two walks documents are of different worlds".into());
	}
	let mut header = grid.header.clone();
	header.insert("router".into(), json!("hybrid"));
	header.insert("hybridSlack".into(), json!(slack));
	let mut pairs_out = Vec::new();
	let mut stats = Vec::new();
	let mut zones = (vec![0u32], Vec::new(), Vec::new());
	let mut walkable: FxHashSet<(u32, u32)> = FxHashSet::default();
	for (bi, band) in grid.bands.iter().enumerate() {
		let li = leffe.bands.iter().position(|b| b == band).ok_or(format!("hybrid: Leffe's document has no band {band}"))?;
		let (g, l) = (directed(&grid.pairs[bi]), directed(&leffe.pairs[li]));
		// Each directed walk: (from Leffe?, the walk).
		let mut keys: Vec<(u32, u32)> = g.keys().chain(l.keys()).copied().collect::<FxHashSet<_>>().into_iter().collect();
		keys.sort_unstable();
		let mut pick: FxHashMap<(u32, u32), (bool, W)> = FxHashMap::default();
		let (mut n_g, mut n_l, mut none, mut detour) = (0usize, 0usize, 0usize, 0usize);
		for k in &keys {
			let c = match (g.get(k), l.get(k)) {
				(Some(gw), Some(lw)) if lw.cost <= slack * gw.cost => (true, *lw),
				(Some(gw), Some(_)) => {
					detour += 1;
					(false, *gw)
				}
				(Some(gw), None) => {
					none += 1;
					(false, *gw)
				}
				(None, Some(lw)) => (true, *lw),
				(None, None) => unreachable!(),
			};
			if c.0 {
				n_l += 1;
			} else {
				n_g += 1;
			}
			pick.insert(*k, c);
		}
		// Emit: a pair both ways when both directions took the same both-ways walk, else each direction one-way.
		let mut out: Vec<f64> = Vec::new();
		let mut src: Vec<(bool, usize)> = Vec::new();
		for &(a, b) in &keys {
			let (fl, w) = pick[&(a, b)];
			if a > b {
				if let Some(&(rl, rw)) = pick.get(&(b, a)) {
					if rl == fl && rw.k == w.k && w.both {
						continue; // emitted from (b, a)
					}
				}
			}
			let same_back = pick.get(&(b, a)).is_some_and(|&(rl, rw)| rl == fl && rw.k == w.k && w.both);
			out.extend([a as f64, b as f64, w.yd, w.cost, if same_back { 0.0 } else { 1.0 }]);
			src.push((fl, w.k));
			if *band == 0 {
				walkable.insert((a, b));
				walkable.insert((b, a));
			}
		}
		if *band == 0 {
			for &(fl, k) in &src {
				let z = if fl { leffe.zones.as_ref() } else { grid.zones.as_ref() };
				if let Some((off, val, has)) = z {
					if has[k] != 0 {
						zones.1.extend_from_slice(&val[off[k] as usize..off[k + 1] as usize]);
						zones.2.push(1);
					} else {
						zones.2.push(0);
					}
				} else {
					zones.2.push(0);
				}
				zones.0.push(zones.1.len() as u32);
			}
		}
		stats.push(json!({"band": band, "walks": keys.len(), "grid": n_g, "leffe": n_l, "leffeNone": none, "leffeDetour": detour}));
		pairs_out.push((*band, out));
	}
	// Unwalkable: either document's, where the merged base holds no walk.
	let mut unwalkable = Vec::new();
	let mut seen = FxHashSet::default();
	for u in grid.unwalkable.chunks_exact(2).chain(leffe.unwalkable.chunks_exact(2)) {
		let k = (u[0].min(u[1]), u[0].max(u[1]));
		if !walkable.contains(&(u[0] as u32, u[1] as u32)) && seen.insert(k) {
			unwalkable.extend([u[0], u[1]]);
		}
	}
	Ok((Doc { header, pairs: pairs_out, unwalkable, zones }, json!({ "slack": slack, "bands": stats })))
}

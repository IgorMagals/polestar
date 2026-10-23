//! World parity driver: builds each faction's world in Rust from a repository checkout and
//! compares it with the JS world file byte for byte (then field by field on a mismatch).
//!
//!   world-parity <repo> <js-sim-dir> [out-dir] [faction...]
//!
//! <js-sim-dir> holds the JS reference worlds (world-<faction>.json) and the floors cache the
//! JS build used (floors.json): the Rust build reads the same floors, so heights agree.

use forge_core::Faction;
use forge_world::{json, FloorCache, World};
use serde_json::Value;
use std::path::PathBuf;
use std::time::Instant;

fn first_diff(path: &str, a: &Value, b: &Value, out: &mut Vec<String>, limit: usize) {
	if out.len() >= limit {
		return;
	}
	match (a, b) {
		(Value::Object(x), Value::Object(y)) => {
			let xk: Vec<&String> = x.keys().collect();
			let yk: Vec<&String> = y.keys().collect();
			if xk != yk {
				out.push(format!("{path}: keys rust {xk:?} js {yk:?}"));
				return;
			}
			for (k, v) in x {
				first_diff(&format!("{path}.{k}"), v, &y[k], out, limit);
			}
		}
		(Value::Array(x), Value::Array(y)) => {
			if x.len() != y.len() {
				out.push(format!("{path}: length rust {} js {}", x.len(), y.len()));
			}
			for (i, (v, w)) in x.iter().zip(y).enumerate() {
				first_diff(&format!("{path}[{i}]"), v, w, out, limit);
				if out.len() >= limit {
					return;
				}
			}
		}
		_ => {
			let same = match (a.as_f64(), b.as_f64()) {
				(Some(p), Some(q)) => p.to_bits() == q.to_bits() || (p == 0.0 && q == 0.0),
				_ => a == b,
			};
			if !same {
				out.push(format!("{path}: rust {} js {}", json::stringify(a), json::stringify(b)));
			}
		}
	}
}

fn main() {
	let args: Vec<String> = std::env::args().collect();
	if args.len() < 3 {
		eprintln!("usage: world-parity <repo> <js-sim-dir> [out-dir] [faction...]");
		std::process::exit(2);
	}
	let repo = PathBuf::from(&args[1]);
	let js_dir = PathBuf::from(&args[2]);
	let out_dir = args.get(3).map(PathBuf::from);
	let factions: Vec<Faction> = if args.len() > 4 { args[4..].iter().filter_map(|f| Faction::parse(f)).collect() } else { Faction::BOTH.to_vec() };
	let t0 = Instant::now();
	let floors = FloorCache::from_json(&std::fs::read(js_dir.join("floors.json")).expect("floors.json")).expect("floors.json parse");
	eprintln!("floors cache: {} places, key {} ({:.2} s)", floors.len(), floors.key, t0.elapsed().as_secs_f64());
	let mut failed = false;
	for f in factions {
		let t = Instant::now();
		let (w, d) = World::load_with(&repo, f, &floors).expect("world");
		let built = t.elapsed().as_secs_f64();
		let text = w.to_json();
		let total = t.elapsed().as_secs_f64();
		let grid = repo.join("data/local/nav4");
		if grid.join("tiles").exists() {
			let ta = Instant::now();
			let sub = forge_world::atlas::GridSubzones::open(&grid, &repo.join("data/sources"));
			let a = forge_world::Atlas::build(&w, &d, Some(&sub));
			eprintln!("{f}: atlas {:.2} s, {} areas, {} zones, {} roles", ta.elapsed().as_secs_f64(), a.areas.len(), a.zones.len(), a.roles.len());
		}
		if let Some(o) = &out_dir {
			std::fs::create_dir_all(o).ok();
			std::fs::write(o.join(format!("rust-world-{}.json", f.lower())), &text).expect("write");
		}
		let js = std::fs::read_to_string(js_dir.join(format!("world-{}.json", f.lower()))).expect("JS world");
		let equal = js == text;
		eprintln!(
			"{f}: build {built:.2} s, build+serialize {total:.2} s, {} points, {} quests, {} camps, {} areas; bytes {} vs JS {}: {}",
			w.points.len(),
			w.quests.len(),
			w.camps.len(),
			w.areas.len(),
			text.len(),
			js.len(),
			if equal { "IDENTICAL" } else { "DIFFER" }
		);
		if !equal {
			failed = true;
			let a: Value = serde_json::from_str(&text).expect("rust json");
			let b: Value = serde_json::from_str(&js).expect("js json");
			let (Value::Object(x), Value::Object(y)) = (&a, &b) else { continue };
			let xk: Vec<&String> = x.keys().collect();
			let yk: Vec<&String> = y.keys().collect();
			if xk != yk {
				eprintln!("  top-level keys differ:\n    rust {xk:?}\n    js   {yk:?}");
			}
			for (k, v) in y {
				let Some(r) = x.get(k) else {
					eprintln!("  {k}: missing in rust");
					continue;
				};
				let mut out = Vec::new();
				first_diff(k, r, v, &mut out, 6);
				if !out.is_empty() {
					eprintln!("  {k}: DIFFERS");
					for l in out {
						eprintln!("    {l}");
					}
				} else if json::stringify(r) != json::stringify(v) {
					eprintln!("  {k}: same values, different bytes");
				}
			}
		}
	}
	std::process::exit(i32::from(failed));
}

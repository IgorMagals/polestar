//! gear-parity: runs the Rust `gear build` and compares every output with a JS reference checkout
//! (where `node tools/polestar.js gear build` ran). report.json's builtAt is taken from the
//! reference, so the whole file must match.
//!
//! usage: gear-parity --ref <checkout the JS wrote into> [--root <checkout>] [--addons <AddOns>] [--wowsims <cache>]

use std::path::PathBuf;
use std::time::Instant;

use forge_data::gear::{build, Options};

fn main() {
	let mut args = std::env::args().skip(1);
	let (mut root, mut refdir, mut addons, mut wowsims) = (PathBuf::from("."), None, None, None);
	while let Some(a) = args.next() {
		let mut val = || PathBuf::from(args.next().unwrap_or_else(|| panic!("{a} needs a value")));
		match a.as_str() {
			"--root" => root = val(),
			"--ref" => refdir = Some(val()),
			"--addons" => addons = Some(val()),
			"--wowsims" => wowsims = Some(val()),
			_ => {
				eprintln!("usage: gear-parity --ref DIR [--root DIR] [--addons DIR] [--wowsims DIR]");
				std::process::exit(2);
			}
		}
	}
	let refdir = refdir.unwrap_or_else(|| root.clone());
	let built_at =
		std::fs::read_to_string(refdir.join("data/forever/gear/report.json")).ok().and_then(|t| forge_guide::js::parse_json(&t).ok()).map(|v| v.get("builtAt").to_js_string()).unwrap_or_default();
	let t = Instant::now();
	let out = match build(&Options { root, addons, wowsims_cache: wowsims, built_at }) {
		Ok(o) => o,
		Err(e) => {
			eprintln!("gear build failed: {e}");
			std::process::exit(1);
		}
	};
	let ms = t.elapsed().as_millis();
	print!("{}", out.summary);
	let mut bad = 0;
	for (rel, text) in &out.files {
		let want = std::fs::read(refdir.join(rel));
		let verdict = match &want {
			Ok(w) if w == text.as_bytes() => "identical".to_string(),
			Ok(w) => {
				bad += 1;
				let line = w.split(|b| *b == b'\n').zip(text.as_bytes().split(|b| *b == b'\n')).position(|(a, b)| a != b).map(|i| i + 1);
				format!("DIFFERS ({} vs {} bytes, first line {})", text.len(), w.len(), line.map(|l| l.to_string()).unwrap_or_else(|| "(prefix)".into()))
			}
			Err(e) => {
				bad += 1;
				format!("MISSING in reference ({e})")
			}
		};
		println!("{rel}: {verdict}");
	}
	println!("rust gear build: {ms} ms");
	std::process::exit(if bad > 0 { 1 } else { 0 });
}

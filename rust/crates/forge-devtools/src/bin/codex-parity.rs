//! Parity check of the Rust `codex build` (forge_data::codex) against a JS reference run:
//!
//!   codex-parity --root <checkout> --ref <dir holding codex/ and Polestar_Codex/> [--addons DIR]
//!                [--no-parity] [--write DIR]
//!
//! The reference: `node tools/polestar.js codex build --offline --out <ref>/codex --pack
//! <ref>/Polestar_Codex` in that checkout. meta.json's pack.loadMs (a timing) is taken from the
//! reference's meta.json; every other byte is compared.

use std::path::PathBuf;
use std::time::Instant;

use forge_data::codex;

fn main() {
	let mut args = std::env::args().skip(1);
	let mut root: Option<PathBuf> = None;
	let mut reference: Option<PathBuf> = None;
	let mut addons: Option<PathBuf> = None;
	let mut write: Option<PathBuf> = None;
	let mut parity = true;
	while let Some(a) = args.next() {
		match a.as_str() {
			"--root" => root = args.next().map(PathBuf::from),
			"--ref" => reference = args.next().map(PathBuf::from),
			"--addons" => addons = args.next().map(PathBuf::from),
			"--write" => write = args.next().map(PathBuf::from),
			"--no-parity" => parity = false,
			_ => {
				eprintln!("usage: codex-parity --root <checkout> --ref <dir> [--addons DIR] [--no-parity] [--write DIR]");
				std::process::exit(2);
			}
		}
	}
	let (Some(root), Some(reference)) = (root, reference) else {
		eprintln!("--root and --ref are required");
		std::process::exit(2);
	};
	let ref_codex = reference.join("codex");
	let ref_pack = reference.join(codex::pack::ADDON);
	let mut opts = codex::Options::new(&root);
	opts.addons = addons;
	if !parity {
		opts.parity_against = None;
	}
	if let Ok(text) = std::fs::read_to_string(ref_codex.join("meta.json")) {
		let meta = forge_guide::js::parse_json(&text).unwrap();
		let ms = meta.get("pack").get("loadMs");
		if ms.is_num() {
			opts.load_ms = Some(ms.num());
		}
	}
	let t0 = Instant::now();
	let out = match codex::build_logged(&opts, &|m| eprintln!("{m}")) {
		Ok(o) => o,
		Err(e) => {
			eprintln!("error: {e}");
			std::process::exit(1);
		}
	};
	let secs = t0.elapsed().as_secs_f64();
	for w in &out.warnings {
		eprintln!("warning: {w}");
	}
	for l in &out.report {
		println!("{l}");
	}
	if let Some(dir) = write {
		codex::write(&out, &dir.join("codex"), &dir.join(codex::pack::ADDON)).unwrap();
	}
	let mut bad = 0;
	let mut check = |name: String, ours: &str, file: PathBuf| {
		let theirs = std::fs::read_to_string(&file).unwrap_or_default();
		if theirs == ours {
			println!("identical  {name}");
		} else {
			bad += 1;
			let line = ours.lines().zip(theirs.lines()).position(|(a, b)| a != b).map(|i| i + 1).unwrap_or(ours.lines().count().min(theirs.lines().count()) + 1);
			println!("DIFFERENT  {name} (first difference at line {line}; {} vs {} bytes)", ours.len(), theirs.len());
		}
	};
	for (n, t) in &out.json {
		check(format!("codex/{n}"), t, ref_codex.join(n));
	}
	for (n, t) in &out.pack {
		check(format!("{}/{n}", codex::pack::ADDON), t, ref_pack.join(n));
	}
	let mut theirs: Vec<String> = std::fs::read_dir(&ref_pack).map(|rd| rd.flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect()).unwrap_or_default();
	theirs.retain(|f| !out.pack.iter().any(|(n, _)| n == f));
	for f in theirs {
		bad += 1;
		println!("MISSING    {}/{f}", codex::pack::ADDON);
	}
	println!("rust build: {secs:.2} s");
	std::process::exit(if bad > 0 { 1 } else { 0 });
}

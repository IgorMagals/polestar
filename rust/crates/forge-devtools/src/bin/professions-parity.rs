//! professions-parity <checkout root> <JS professions.json> [--build <forever build>] [--out <dir>]:
//! builds professions.json from the checkout's data/forever and data/sources and compares it byte
//! for byte with the file `node tools/polestar.js profession build --offline` wrote.

use std::path::PathBuf;
use std::time::Instant;

use forge_data::professions::{build, write, Options};

fn main() {
	let mut args = std::env::args().skip(1);
	let mut pos: Vec<String> = Vec::new();
	let mut forever_build = None;
	let mut out_dir: Option<PathBuf> = None;
	while let Some(a) = args.next() {
		match a.as_str() {
			"--build" => forever_build = args.next(),
			"--out" => out_dir = args.next().map(PathBuf::from),
			_ => pos.push(a),
		}
	}
	let [root, js] = &pos[..] else {
		eprintln!("usage: professions-parity <checkout root> <JS professions.json> [--build <forever build>] [--out <dir>]");
		std::process::exit(2);
	};
	let mut opts = Options::new(root.as_ref());
	opts.build = forever_build;
	let t = Instant::now();
	let out = match build(&opts) {
		Ok(o) => o,
		Err(e) => {
			eprintln!("error: {e}");
			std::process::exit(1);
		}
	};
	let ms = t.elapsed().as_millis();
	for w in &out.warnings {
		eprintln!("warning: {w}");
	}
	eprintln!("Forever {} (Era {}), built in {ms} ms:\n{}", out.build, out.era_build, out.report.join("\n"));
	if let Some(dir) = &out_dir {
		if let Err(e) = write(dir, &out) {
			eprintln!("error: {e}");
			std::process::exit(1);
		}
	}
	let want = match std::fs::read(js) {
		Ok(b) => b,
		Err(e) => {
			eprintln!("{js}: {e}");
			std::process::exit(1);
		}
	};
	let (name, text) = &out.files[0];
	let got = text.as_bytes();
	if got == want.as_slice() {
		println!("{name}: identical ({} bytes)", got.len());
		return;
	}
	let at = got.iter().zip(&want).position(|(a, b)| a != b).unwrap_or(got.len().min(want.len()));
	let line = got[..at].iter().filter(|&&c| c == b'\n').count() + 1;
	let ctx = |b: &[u8]| String::from_utf8_lossy(&b[at.saturating_sub(120)..(at + 120).min(b.len())]).into_owned();
	println!("{name}: DIFFERS at byte {at} (line {line}; {} vs {} bytes)\n  rust: {}\n  js:   {}", got.len(), want.len(), ctx(got), ctx(&want));
	std::process::exit(1);
}

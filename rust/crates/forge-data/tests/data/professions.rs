//! `profession build` (professions.json, its report and warnings) against the JavaScript's output on
//! client table slices for four professions, the world slice's npcs and objects, an items.json cut and
//! pfQuest's vendor stock: rust/tests/golden/professions (README there).

use crate::common;

use forge_data::professions::{build, Options};

#[test]
fn professions_match_golden() {
	let g = common::golden("professions");
	let input = g.join("input");
	// The build reads one data folder: the golden's items.json beside the world slice's npcs and objects.
	let data = common::scratch("professions");
	std::fs::copy(input.join("data/items.json"), data.join("items.json")).unwrap();
	let world = common::golden("world").join("root/data/forever");
	for f in ["npcs.json", "objects.json"] {
		std::fs::copy(world.join(f), data.join(f)).unwrap();
	}
	let mut o = Options::new(&input);
	o.data = data;
	o.sources = input.join("sources");
	let out = build(&o).unwrap();
	let want = g.join("expected");
	let mut check = common::Check::new();
	let mut names = Vec::new();
	for (name, text) in &out.files {
		check.file(name, text, &want.join(name));
		names.push(name.clone());
	}
	let report = format!("wrote professions.json from Forever build {} (gaps filled from Classic Era {}):\n{}\n", out.build, out.era_build, out.report.join("\n"));
	check.file("report.txt", &report, &want.join("report.txt"));
	let warnings: String = out.warnings.iter().map(|w| format!("warning: {w}\n")).collect();
	check.file("warnings.txt", &warnings, &want.join("warnings.txt"));
	names.extend(["report.txt".into(), "warnings.txt".into()]);
	check.all_of(&want, &names);
	check.finish("profession build");
}

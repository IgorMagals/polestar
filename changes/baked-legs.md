---
section: contributors
---
- `node tools/polestar.js bake` routes the walk into each step of the class
  route guides on the navigation grid and writes it beside them
  (`legs.json`, with a QA list of the legs it would not write); compile puts
  each guide's legs into its race part as one string per step (pack format
  6), and `Polestar.Nav.BakedLeg(step)` hands the arrow's follower the
  polyline (points, heights, yards to the goal, segment classes, the ground
  every 2 yd).
- `bake` keeps every routed leg in `data/local/legcache/` (one file per
  router version, keyed by the leg's ends and the profile, with the content
  hash of each grid tile the leg crosses), so a rebake routes only the legs
  it has not seen or whose tiles changed; `--cache <dir>` moves it.

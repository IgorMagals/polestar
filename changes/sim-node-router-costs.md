---
section: contributors
---
- `sim walks`' node router prices a walk as the in-game router does: roads
  are preferred, rivers are crossed by bridges rather than swum, the other
  faction's towns are walked round and dangerous zones too, on the coarse
  graph as on the grid (one walk graph per faction, each edge's zones
  measured), and an end on a ledge or in a doorway the grid shuts one way is
  moved beside it. The whole cost model is written down once, in
  tools/lib/nav/edgecost.js. `sim walks --parity` takes the grid with
  `--dir`.

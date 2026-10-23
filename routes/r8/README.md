# r8 Orc and Human (ledger test input)

Cut on the v1-seed world (Rust-built from lodestar-v1-seed eb7b47840 data, Leffe-free node-router walks), avg profile, edit budget at the knee + pickups. All 10 starts are recut after forge build works.

- `<start>.json`: the order (steps, levels, route items), edits, passed-by summary.
- `<start>.skips.json`, `<start>-skips.md`: the skip ledger (quests not taken, reason, numbers, missing info and where a fix goes).
- `<start>.edits.json`, `<start>-ledger.md`: the edit ledger (each kept edit against v1, minutes saved, guards passed, its `revert` line).
- `missing-info.md`: `polestar-sim skips --reason missing-info --dir routes/r8`.

`polestar-sim why <quest> --start Orc --dir routes/r8` answers for included, moved and skipped quests.

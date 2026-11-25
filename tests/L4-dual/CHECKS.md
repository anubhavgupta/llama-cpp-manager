# L4-dual — dual-run field diff (legacy vs candidate)

Purpose: run two manager instances side by side (ports 7841/7842) against identical fixture
trees, drive an identical probe sequence, and diff the captured field sets. A=base, B=candidate.

## Candidate requirement (HIGH, easy to trip on)

Both sides are materialised with `git archive` from **git refs in this repo**
(`run.js:2-16`) — a Part-2 candidate must be committed and passed as `--ref-a <ref>`.
A loose directory works for L2/L3 but NOT for L4.

## Commands

| Command | Meaning |
|---|---|
| `node tests/L4-dual/run.js --ref-a <ref> --ref-b <ref>` | full dual-run field diff (candidate vs `parity-baseline`) |
| `node tests/L4-dual/run.js --self-mode` | A=B gate: both sides materialised from the same ref; asserts the harness itself is deterministic (62 fields/side, 0 diffs). Negative control for the diff machinery does NOT exist (recorded gap: PARITY.md remediation rows; fixtures/NEGATIVES.md has no L4 row) — a broken comparator would have to be caught via `--self-mode` plus L1–L3 |
| `--only backend` | restrict to the backend probe family (27 fields/side; used by the recorded capability probe) |

Takes the executor lock (`tools/parity/parity-lock.js`); refuses while another gate holds it.

## Check inventory

`--self-mode` asserts, per side: settings GET/POST round-trip bytes, /models listing,
/status transitions, argv captured from the stand-in (launch sequence identity),
socket.io log-chunk stream shape, ini bytes after presets launch, and the 62-field
probe summary (`fieldManifest`-driven; see `SPEC/field-manifest.json`). Field set =
whatever `run.js` probes; the self-mode count (62) is the inventory.

# Phase 2.6 — mutation testing the two baseline generators

Machine-written by `node tools/parity/equiv-prove.js`. Reproduce with:

```
node tools/parity/mutate.js --selftest
node tools/parity/mutate.js --dump
node tools/parity/mutation-run.js --selftest
node tools/parity/mutation-run.js --tier1 300 --workers 8
node tools/parity/equiv-prove.js
```

- mutated source: the `parity-baseline` inline blocks sliced by `tools/parity/baseline-slices.js`,
  mutated **in memory** — `public/script.js`, `legacy/lib`, `fixtures/**` and `tests/**` are untouched.
- inputs: private snapshot of the committed `9d6a767` vectors + goldens (`tools/parity/reports/mutation/.snapshot/`, 15 files, 0 mismatching that commit); goldens impl 
  `parity-baseline@c57f4381425a97a0ef1b830a8314f126e5971c0f`. A fixture re-record runs concurrently, so live `fixtures/**` is
  never read: a mutation baseline that moves under the run cannot be compared with the ledger.
- site inventory: `SPEC/SPEC-ROWS.csv`, `BA-*`/`INI-*` rows (line + kind per row).

## Totals

| | count |
|---|---|
| mutants enumerated | 706 |
| killed by a recorded vector | 648 |
| survived | 58 |
| survived, equivalent — static proof | 15 |
| survived, equivalent — exhaustive-probe proof | 43 |
| survived, gap — killing vector synthesized | 0 |
| unresolved gaps | 0 |
| killed + explained | 706 of 706 |
| **mutation score (killed / enumerated)** | **91.78%** |
| **ceiling score (killed + proven-equivalent + gap-killer) / enumerated** | **100.00%** |

Runtime: kill check 12.0s on 8 worker process(es); tier 1 = first 300 vectors of 2752, 11 mutants needed the remaining 2452. Tier control: 64 seeded tier-1 kills re-run over the full set, 0 disagreement(s).

## By class

| class | mutants | killed | equiv-static | equiv-dynamic | gap (killer synthesized) | unresolved |
|---|---|---|---|---|---|---|
| string-literal | 221 | 216 | 0 | 5 | 0 | 0 |
| statement-removal | 80 | 80 | 0 | 0 | 0 | 0 |
| conditional-inversion | 75 | 75 | 0 | 0 | 0 | 0 |
| boolean-operator | 56 | 55 | 0 | 1 | 0 | 0 |
| operand-removal | 56 | 49 | 0 | 7 | 0 | 0 |
| equality-complement | 47 | 47 | 0 | 0 | 0 | 0 |
| equality-strictness | 47 | 12 | 15 | 20 | 0 | 0 |
| negation-insertion | 41 | 35 | 0 | 6 | 0 | 0 |
| numeric-literal | 35 | 35 | 0 | 0 | 0 | 0 |
| relational-boundary | 22 | 18 | 0 | 4 | 0 | 0 |
| relational-reverse | 22 | 22 | 0 | 0 | 0 | 0 |
| branch-swap | 2 | 2 | 0 | 0 | 0 | 0 |
| loop-body-removal | 1 | 1 | 0 | 0 | 0 | 0 |
| loop-first-iteration | 1 | 1 | 0 | 0 | 0 | 0 |

## Regions the gate does not score: `save` and `server`

`config` / `args` / `ini` are the regions this report scores. Two more have sites in
`tools/parity/mutate.js` and no verdicts here — and the difference between `unscored`
and `equivalent` is exactly what this table is for.

| region | site inventory | mutants the enumerator produces | in `mutants.json` | scored in `run.json` | killed | survived | proven in this report |
|---|---|---|---|---|---|---|---|
| `save` | `SCV-*` rows (28) over the `ANCHORS.SAVE_START` slice of `public/script.js` | 59 | 0 | 0 | 0 | 0 | 0 |
| `server` | `SV-*` rows (49) over the whole `parity-baseline:server.js` blob | 152 | 0 | 0 | 0 | 0 | 0 |

The `save` figure is what `node tools/parity/mutate.js --dump` would ship today; the
`server` figure is what `node tools/parity/mutate.js --dump-server` writes to its own
unrun file — `--dump` produces 0 server mutants, and `--dump-server` asserts that it
stays that way. That assertion is the ruling this table records.

**`save` — the channel exists; the shipped run predates it.** `mutate.js` enumerates
59 save mutants from the 28 `SCV-*` rows and scores them against the
recorded re-save corpus (`fixtures/goldens/resave/`), and the
`unreachable-element-guard-fallback` static strategy is asserted by name in
`node tools/parity/equiv-prove.js --selftest`. The
committed `mutants.json` was written before the region landed, so those mutants are
not in it, carry no verdict in `run.json`, and own no file in `proofs/`. Regenerating
`mutants.json` + `run.json` + this report moves a pinned artifact (C8): that is a ledger
entry for the pin holder, not a step this tool takes on its own authority. Until then
the save region is reported as unscored, never as clean.

**`server` — enumerated, deliberately unrun** (`status: enumerated-unrun`, in
`tools/parity/reports/mutation/SERVER-REGION-ENUMERATION.json`, written by `node tools/parity/mutate.js --dump-server`):
152 mutants over 47/49 `SV-*` rows; classes boolean-operator, branch-swap, conditional-inversion, equality-complement, equality-strictness, negation-insertion, numeric-literal, operand-removal, relational-boundary, relational-reverse, string-literal;
0 rejected because the mutated file will not parse.
They are NOT in `mutants.json` (0 `server`-region ids there)
because `mutation-run.js` kills through the argv/ini/save channels and no channel
reaches a route: a scored run would print `survived` where the truth is `unmeasured`.
`tools/parity/tasks/task-server-mutation.md` is the work that makes them scoreable
(kill channel first, then `bodyStatements()` learn the `res.json` / `io.emit` emit
shapes, which is why the enumeration has no statement-removal mutants at all). The
one server-region claim the suites make today is a negative control, not inventory:
`SV-get-settings-3-string-literal` in `fixtures/NEGATIVES.md`, red as named on
`L1.SETTINGS.FIRST-RUN.BYTES`.

## Per-row map (every BA-*/INI-* row)

`survivors` counts mutants that no recorded vector killed; each one is accounted for in
`proofs/`. Rows with no generator site are the launch preludes (alert-and-return guards,
response handling, catch clauses): no generator input reaches them, so they are asserted by
the L1 HTTP suites (plan §4), not here — the "note" column says which.

| row | kind | file:line | mutants | killed | survivors | outcome | note |
|---|---|---|---|---|---|---|---|
| BA-1 | if | public/script.js:412 | 0 | 0 | 0 | no generator site | outside both generators: launchServer, unreachable from a generator input (C2 for dead code, L1 for live preludes) |
| BA-2 | if | public/script.js:418 | 0 | 0 | 0 | no generator site | outside both generators: launchServer, unreachable from a generator input (C2 for dead code, L1 for live preludes) |
| BA-3 | if | public/script.js:465 | 0 | 0 | 0 | no generator site | outside both generators: launchServer, unreachable from a generator input (C2 for dead code, L1 for live preludes) |
| BA-4 | if | public/script.js:491 | 0 | 0 | 0 | no generator site | outside both generators: launchServer, unreachable from a generator input (C2 for dead code, L1 for live preludes) |
| BA-5 | error-path | public/script.js:500 | 0 | 0 | 0 | no generator site | outside both generators: launchServer, unreachable from a generator input (C2 for dead code, L1 for live preludes) |
| BA-6 | truthiness | legacy/lib/buildArgs.js:33 | 1 | 1 | 0 | — | every mutant killed by a recorded vector |
| BA-7 | logical-or | legacy/lib/buildArgs.js:33 | 3 | 2 | 1 | equivalent-dynamic:1 | proofs: config-004-0038-operand-removal-17d0e57dcf |
| BA-8 | truthiness | legacy/lib/buildArgs.js:34 | 1 | 1 | 0 | — | every mutant killed by a recorded vector |
| BA-9 | logical-or | legacy/lib/buildArgs.js:34 | 3 | 3 | 0 | — | every mutant killed by a recorded vector |
| BA-10 | truthiness | legacy/lib/buildArgs.js:35 | 1 | 1 | 0 | — | every mutant killed by a recorded vector |
| BA-11 | logical-or | legacy/lib/buildArgs.js:35 | 3 | 3 | 0 | — | every mutant killed by a recorded vector |
| BA-12 | truthiness | legacy/lib/buildArgs.js:36 | 1 | 1 | 0 | — | every mutant killed by a recorded vector |
| BA-13 | logical-or | legacy/lib/buildArgs.js:36 | 3 | 2 | 1 | equivalent-dynamic:1 | proofs: config-007-0040-operand-removal-88866c23a5 |
| BA-14 | truthiness | legacy/lib/buildArgs.js:37 | 1 | 1 | 0 | — | every mutant killed by a recorded vector |
| BA-15 | logical-or | legacy/lib/buildArgs.js:37 | 3 | 3 | 0 | — | every mutant killed by a recorded vector |
| BA-16 | truthiness | legacy/lib/buildArgs.js:38 | 1 | 1 | 0 | — | every mutant killed by a recorded vector |
| BA-17 | logical-or | legacy/lib/buildArgs.js:38 | 3 | 3 | 0 | — | every mutant killed by a recorded vector |
| BA-18 | truthiness | legacy/lib/buildArgs.js:39 | 1 | 1 | 0 | — | every mutant killed by a recorded vector |
| BA-19 | logical-or | legacy/lib/buildArgs.js:39 | 3 | 3 | 0 | — | every mutant killed by a recorded vector |
| BA-20 | truthiness | legacy/lib/buildArgs.js:40 | 1 | 1 | 0 | — | every mutant killed by a recorded vector |
| BA-21 | logical-or | legacy/lib/buildArgs.js:40 | 3 | 3 | 0 | — | every mutant killed by a recorded vector |
| BA-22 | truthiness | legacy/lib/buildArgs.js:41 | 3 | 3 | 0 | — | every mutant killed by a recorded vector |
| BA-23 | logical-or | legacy/lib/buildArgs.js:41 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: config-012-0070-operand-removal-e7cec54bcb |
| BA-24 | truthiness | legacy/lib/buildArgs.js:45 | 1 | 1 | 0 | — | every mutant killed by a recorded vector |
| BA-25 | logical-or | legacy/lib/buildArgs.js:45 | 3 | 3 | 0 | — | every mutant killed by a recorded vector |
| BA-26 | truthiness | legacy/lib/buildArgs.js:46 | 1 | 1 | 0 | — | every mutant killed by a recorded vector |
| BA-27 | logical-or | legacy/lib/buildArgs.js:46 | 3 | 2 | 1 | equivalent-dynamic:1 | proofs: config-017-0046-operand-removal-50b72c86f8 |
| BA-28 | truthiness | legacy/lib/buildArgs.js:53 | 1 | 1 | 0 | — | every mutant killed by a recorded vector |
| BA-29 | logical-or | legacy/lib/buildArgs.js:53 | 3 | 2 | 1 | equivalent-dynamic:1 | proofs: config-024-0058-operand-removal-8776a536a7 |
| BA-30 | truthiness | legacy/lib/buildArgs.js:64 | 1 | 1 | 0 | — | every mutant killed by a recorded vector |
| BA-31 | logical-or | legacy/lib/buildArgs.js:64 | 3 | 3 | 0 | — | every mutant killed by a recorded vector |
| BA-32 | if | legacy/lib/buildArgs.js:72 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-33 | range-comparison | legacy/lib/buildArgs.js:76 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| BA-34 | range-comparison | legacy/lib/buildArgs.js:80 | 7 | 6 | 1 | equivalent-dynamic:1 | proofs: args-012-0027-relational-boundary-067339c491 |
| BA-35 | range-comparison | legacy/lib/buildArgs.js:84 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| BA-36 | range-comparison | legacy/lib/buildArgs.js:88 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| BA-37 | range-comparison | legacy/lib/buildArgs.js:92 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| BA-38 | logical-or | legacy/lib/buildArgs.js:96 | 12 | 11 | 1 | equivalent-dynamic:1 | proofs: args-028-0086-string-literal-62150ea11c |
| BA-39 | logical-and | legacy/lib/buildArgs.js:96 | 9 | 8 | 1 | equivalent-dynamic:1 | proofs: args-028-0060-equality-strictness-69a83a6367 |
| BA-40 | truthiness | legacy/lib/buildArgs.js:96 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-41 | neq-comparison | legacy/lib/buildArgs.js:96 | 7 | 6 | 1 | equivalent-dynamic:1 | proofs: args-028-0060-equality-strictness-69a83a6367 |
| BA-42 | eq-comparison | legacy/lib/buildArgs.js:96 | 7 | 6 | 1 | equivalent-dynamic:1 | proofs: args-028-0086-string-literal-62150ea11c |
| BA-43 | logical-or | legacy/lib/buildArgs.js:100 | 12 | 11 | 1 | equivalent-dynamic:1 | proofs: args-032-0113-string-literal-a6729af193 |
| BA-44 | logical-and | legacy/lib/buildArgs.js:100 | 9 | 8 | 1 | equivalent-dynamic:1 | proofs: args-032-0078-equality-strictness-4a7242bf03 |
| BA-45 | truthiness | legacy/lib/buildArgs.js:100 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-46 | neq-comparison | legacy/lib/buildArgs.js:100 | 7 | 6 | 1 | equivalent-dynamic:1 | proofs: args-032-0078-equality-strictness-4a7242bf03 |
| BA-47 | eq-comparison | legacy/lib/buildArgs.js:100 | 7 | 6 | 1 | equivalent-dynamic:1 | proofs: args-032-0113-string-literal-a6729af193 |
| BA-48 | logical-or | legacy/lib/buildArgs.js:104 | 12 | 11 | 1 | equivalent-dynamic:1 | proofs: args-036-0119-string-literal-56cf1131a1 |
| BA-49 | logical-and | legacy/lib/buildArgs.js:104 | 9 | 8 | 1 | equivalent-dynamic:1 | proofs: args-036-0082-equality-strictness-74a02e4885 |
| BA-50 | truthiness | legacy/lib/buildArgs.js:104 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-51 | neq-comparison | legacy/lib/buildArgs.js:104 | 7 | 6 | 1 | equivalent-dynamic:1 | proofs: args-036-0082-equality-strictness-74a02e4885 |
| BA-52 | eq-comparison | legacy/lib/buildArgs.js:104 | 7 | 6 | 1 | equivalent-dynamic:1 | proofs: args-036-0119-string-literal-56cf1131a1 |
| BA-53 | range-comparison | legacy/lib/buildArgs.js:109 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| BA-54 | if | legacy/lib/buildArgs.js:113 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-55 | if | legacy/lib/buildArgs.js:117 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-56 | range-comparison | legacy/lib/buildArgs.js:121 | 7 | 6 | 1 | equivalent-dynamic:1 | proofs: args-053-0031-relational-boundary-c05d2a130d |
| BA-57 | range-comparison | legacy/lib/buildArgs.js:125 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| BA-58 | if | legacy/lib/buildArgs.js:129 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-59 | logical-and | legacy/lib/buildArgs.js:134 | 9 | 9 | 0 | — | every mutant killed by a recorded vector |
| BA-60 | truthiness | legacy/lib/buildArgs.js:134 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| BA-61 | logical-and | legacy/lib/buildArgs.js:134 | 8 | 8 | 0 | — | every mutant killed by a recorded vector |
| BA-62 | truthiness | legacy/lib/buildArgs.js:134 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| BA-63 | truthiness | legacy/lib/buildArgs.js:134 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| BA-64 | logical-and | legacy/lib/buildArgs.js:140 | 10 | 9 | 1 | equivalent-static:1 | proofs: args-072-0057-equality-strictness-50f0535372 |
| BA-65 | truthiness | legacy/lib/buildArgs.js:140 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-66 | neq-comparison | legacy/lib/buildArgs.js:140 | 7 | 6 | 1 | equivalent-static:1 | proofs: args-072-0057-equality-strictness-50f0535372 |
| BA-67 | eq-comparison | legacy/lib/buildArgs.js:142 | 47 | 45 | 2 | equivalent-dynamic:1 equivalent-static:1 | proofs: args-074-0040-equality-strictness-c6811a0241, args-123-0039-string-literal-73e321f73d |
| BA-68 | if | legacy/lib/buildArgs.js:149 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-69 | if | legacy/lib/buildArgs.js:154 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-70 | logical-and | legacy/lib/buildArgs.js:159 | 9 | 9 | 0 | — | every mutant killed by a recorded vector |
| BA-71 | truthiness | legacy/lib/buildArgs.js:159 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| BA-72 | truthiness | legacy/lib/buildArgs.js:159 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| BA-73 | if | legacy/lib/buildArgs.js:166 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-74 | if | legacy/lib/buildArgs.js:171 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-75 | if | legacy/lib/buildArgs.js:176 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-76 | if | legacy/lib/buildArgs.js:181 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-77 | logical-and | legacy/lib/buildArgs.js:186 | 8 | 7 | 1 | equivalent-dynamic:1 | proofs: args-118-0028-equality-strictness-f3851f0e66 |
| BA-78 | neq-comparison | legacy/lib/buildArgs.js:186 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: args-118-0028-equality-strictness-f3851f0e66 |
| BA-79 | truthiness | legacy/lib/buildArgs.js:186 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-80 | logical-or | legacy/lib/buildArgs.js:191 | 38 | 36 | 2 | equivalent-dynamic:1 equivalent-static:1 | proofs: args-123-0035-equality-strictness-f8537e7f9e, args-123-0039-string-literal-73e321f73d |
| BA-81 | neq-comparison | legacy/lib/buildArgs.js:191 | 35 | 33 | 2 | equivalent-dynamic:1 equivalent-static:1 | proofs: args-123-0035-equality-strictness-f8537e7f9e, args-123-0039-string-literal-73e321f73d |
| BA-82 | truthiness | legacy/lib/buildArgs.js:191 | 32 | 32 | 0 | — | every mutant killed by a recorded vector |
| BA-83 | if | legacy/lib/buildArgs.js:193 | 2 | 2 | 0 | — | every mutant killed by a recorded vector |
| BA-84 | neq-comparison | legacy/lib/buildArgs.js:194 | 6 | 5 | 1 | equivalent-static:1 | proofs: args-126-0039-equality-strictness-cca128651f |
| BA-85 | range-comparison | legacy/lib/buildArgs.js:195 | 9 | 8 | 1 | equivalent-dynamic:1 | proofs: args-127-0033-relational-boundary-a8471235f6 |
| BA-86 | if | legacy/lib/buildArgs.js:199 | 16 | 16 | 0 | — | every mutant killed by a recorded vector |
| BA-87 | logical-and | legacy/lib/buildArgs.js:205 | 13 | 12 | 1 | equivalent-static:1 | proofs: args-137-0067-equality-strictness-6cccb1595d |
| BA-88 | range-comparison | legacy/lib/buildArgs.js:205 | 6 | 6 | 0 | — | every mutant killed by a recorded vector |
| BA-89 | neq-comparison | legacy/lib/buildArgs.js:205 | 7 | 6 | 1 | equivalent-static:1 | proofs: args-137-0067-equality-strictness-6cccb1595d |
| BA-90 | eq-comparison | legacy/lib/buildArgs.js:211 | 10 | 9 | 1 | equivalent-static:1 | proofs: args-143-0029-equality-strictness-f82e935fdc |
| BA-91 | eq-comparison | legacy/lib/buildArgs.js:213 | 21 | 20 | 1 | equivalent-static:1 | proofs: args-145-0036-equality-strictness-85a1d91dd8 |
| BA-92 | logical-and | legacy/lib/buildArgs.js:218 | 22 | 21 | 1 | equivalent-static:1 | proofs: args-150-0060-equality-strictness-0fb27add41 |
| BA-93 | truthiness | legacy/lib/buildArgs.js:218 | 14 | 14 | 0 | — | every mutant killed by a recorded vector |
| BA-94 | logical-and | legacy/lib/buildArgs.js:218 | 19 | 18 | 1 | equivalent-static:1 | proofs: args-150-0060-equality-strictness-0fb27add41 |
| BA-95 | neq-comparison | legacy/lib/buildArgs.js:218 | 17 | 16 | 1 | equivalent-static:1 | proofs: args-150-0060-equality-strictness-0fb27add41 |
| BA-96 | neq-comparison | legacy/lib/buildArgs.js:218 | 17 | 16 | 1 | equivalent-static:1 | proofs: args-150-0097-equality-strictness-1e05004ea3 |
| BA-97 | range-comparison | legacy/lib/buildArgs.js:220 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| BA-98 | if | legacy/lib/buildArgs.js:223 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-99 | if | legacy/lib/buildArgs.js:226 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| BA-100 | logical-and | legacy/lib/buildArgs.js:238 | 8 | 7 | 1 | equivalent-dynamic:1 | proofs: args-170-0027-equality-strictness-8e1cacedfd |
| BA-101 | eq-comparison | legacy/lib/buildArgs.js:238 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: args-170-0027-equality-strictness-8e1cacedfd |
| BA-102 | truthiness | legacy/lib/buildArgs.js:238 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| INI-1 | if | public/script.js:513 | 0 | 0 | 0 | no generator site | outside both generators: launchModelPresets, unreachable from a generator input (C2 for dead code, L1 for live preludes) |
| INI-2 | eq-comparison | public/script.js:519 | 0 | 0 | 0 | no generator site | outside both generators: launchModelPresets, unreachable from a generator input (C2 for dead code, L1 for live preludes) |
| INI-3 | if | public/script.js:548 | 0 | 0 | 0 | no generator site | outside both generators: launchModelPresets, unreachable from a generator input (C2 for dead code, L1 for live preludes) |
| INI-4 | error-path | public/script.js:557 | 0 | 0 | 0 | no generator site | outside both generators: launchModelPresets, unreachable from a generator input (C2 for dead code, L1 for live preludes) |
| INI-5 | loop-gate | legacy/lib/buildPresetIni.js:27 | 39 | 39 | 0 | — | every mutant killed by a recorded vector |
| INI-6 | if | legacy/lib/buildPresetIni.js:42 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| INI-7 | logical-and | legacy/lib/buildPresetIni.js:48 | 8 | 7 | 1 | equivalent-dynamic:1 | proofs: ini-025-0031-equality-strictness-6a45602833 |
| INI-8 | eq-comparison | legacy/lib/buildPresetIni.js:48 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: ini-025-0031-equality-strictness-6a45602833 |
| INI-9 | truthiness | legacy/lib/buildPresetIni.js:48 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| INI-10 | logical-and | legacy/lib/buildPresetIni.js:54 | 11 | 11 | 0 | — | every mutant killed by a recorded vector |
| INI-11 | neq-comparison | legacy/lib/buildPresetIni.js:54 | 5 | 5 | 0 | — | every mutant killed by a recorded vector |
| INI-12 | range-comparison | legacy/lib/buildPresetIni.js:54 | 6 | 6 | 0 | — | every mutant killed by a recorded vector |
| INI-13 | range-comparison | legacy/lib/buildPresetIni.js:58 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| INI-14 | logical-and | legacy/lib/buildPresetIni.js:62 | 11 | 10 | 1 | equivalent-dynamic:1 | proofs: ini-039-0028-equality-strictness-7799d22852 |
| INI-15 | neq-comparison | legacy/lib/buildPresetIni.js:62 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: ini-039-0028-equality-strictness-7799d22852 |
| INI-16 | range-comparison | legacy/lib/buildPresetIni.js:62 | 6 | 6 | 0 | — | every mutant killed by a recorded vector |
| INI-17 | logical-and | legacy/lib/buildPresetIni.js:66 | 11 | 11 | 0 | — | every mutant killed by a recorded vector |
| INI-18 | neq-comparison | legacy/lib/buildPresetIni.js:66 | 5 | 5 | 0 | — | every mutant killed by a recorded vector |
| INI-19 | range-comparison | legacy/lib/buildPresetIni.js:66 | 6 | 6 | 0 | — | every mutant killed by a recorded vector |
| INI-20 | logical-or | legacy/lib/buildPresetIni.js:70 | 12 | 12 | 0 | — | every mutant killed by a recorded vector |
| INI-21 | logical-and | legacy/lib/buildPresetIni.js:70 | 9 | 8 | 1 | equivalent-dynamic:1 | proofs: ini-047-0064-equality-strictness-5c4c65bcf3 |
| INI-22 | truthiness | legacy/lib/buildPresetIni.js:70 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| INI-23 | neq-comparison | legacy/lib/buildPresetIni.js:70 | 7 | 6 | 1 | equivalent-dynamic:1 | proofs: ini-047-0064-equality-strictness-5c4c65bcf3 |
| INI-24 | eq-comparison | legacy/lib/buildPresetIni.js:70 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| INI-25 | logical-or | legacy/lib/buildPresetIni.js:74 | 12 | 12 | 0 | — | every mutant killed by a recorded vector |
| INI-26 | logical-and | legacy/lib/buildPresetIni.js:74 | 9 | 8 | 1 | equivalent-dynamic:1 | proofs: ini-051-0082-equality-strictness-6527f51eda |
| INI-27 | truthiness | legacy/lib/buildPresetIni.js:74 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| INI-28 | neq-comparison | legacy/lib/buildPresetIni.js:74 | 7 | 6 | 1 | equivalent-dynamic:1 | proofs: ini-051-0082-equality-strictness-6527f51eda |
| INI-29 | eq-comparison | legacy/lib/buildPresetIni.js:74 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| INI-30 | logical-or | legacy/lib/buildPresetIni.js:78 | 12 | 12 | 0 | — | every mutant killed by a recorded vector |
| INI-31 | logical-and | legacy/lib/buildPresetIni.js:78 | 9 | 8 | 1 | equivalent-dynamic:1 | proofs: ini-055-0086-equality-strictness-2bc2f7aaae |
| INI-32 | truthiness | legacy/lib/buildPresetIni.js:78 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| INI-33 | neq-comparison | legacy/lib/buildPresetIni.js:78 | 7 | 6 | 1 | equivalent-dynamic:1 | proofs: ini-055-0086-equality-strictness-2bc2f7aaae |
| INI-34 | eq-comparison | legacy/lib/buildPresetIni.js:78 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| INI-35 | logical-and | legacy/lib/buildPresetIni.js:82 | 11 | 10 | 1 | equivalent-dynamic:1 | proofs: ini-059-0027-equality-strictness-9e4b7e73fb |
| INI-36 | neq-comparison | legacy/lib/buildPresetIni.js:82 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: ini-059-0027-equality-strictness-9e4b7e73fb |
| INI-37 | range-comparison | legacy/lib/buildPresetIni.js:82 | 6 | 6 | 0 | — | every mutant killed by a recorded vector |
| INI-38 | logical-and | legacy/lib/buildPresetIni.js:86 | 11 | 10 | 1 | equivalent-dynamic:1 | proofs: ini-063-0031-equality-strictness-949aaa70d2 |
| INI-39 | neq-comparison | legacy/lib/buildPresetIni.js:86 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: ini-063-0031-equality-strictness-949aaa70d2 |
| INI-40 | range-comparison | legacy/lib/buildPresetIni.js:86 | 6 | 6 | 0 | — | every mutant killed by a recorded vector |
| INI-41 | logical-and | legacy/lib/buildPresetIni.js:90 | 11 | 10 | 1 | equivalent-dynamic:1 | proofs: ini-067-0031-equality-strictness-88fc97f65e |
| INI-42 | neq-comparison | legacy/lib/buildPresetIni.js:90 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: ini-067-0031-equality-strictness-88fc97f65e |
| INI-43 | range-comparison | legacy/lib/buildPresetIni.js:90 | 6 | 6 | 0 | — | every mutant killed by a recorded vector |
| INI-44 | if | legacy/lib/buildPresetIni.js:94 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| INI-45 | range-comparison | legacy/lib/buildPresetIni.js:99 | 7 | 7 | 0 | — | every mutant killed by a recorded vector |
| INI-46 | neq-comparison | legacy/lib/buildPresetIni.js:104 | 6 | 6 | 0 | — | every mutant killed by a recorded vector |
| INI-47 | logical-and | legacy/lib/buildPresetIni.js:108 | 8 | 7 | 1 | equivalent-dynamic:1 | proofs: ini-085-0035-equality-strictness-b7c77e3e63 |
| INI-48 | neq-comparison | legacy/lib/buildPresetIni.js:108 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: ini-085-0035-equality-strictness-b7c77e3e63 |
| INI-49 | truthiness | legacy/lib/buildPresetIni.js:108 | 4 | 3 | 1 | equivalent-dynamic:1 | proofs: ini-085-0016-negation-insertion-2169033dfd |
| INI-50 | logical-and | legacy/lib/buildPresetIni.js:112 | 8 | 7 | 1 | equivalent-dynamic:1 | proofs: ini-089-0039-equality-strictness-fce0d5c541 |
| INI-51 | neq-comparison | legacy/lib/buildPresetIni.js:112 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: ini-089-0039-equality-strictness-fce0d5c541 |
| INI-52 | truthiness | legacy/lib/buildPresetIni.js:112 | 4 | 3 | 1 | equivalent-dynamic:1 | proofs: ini-089-0016-negation-insertion-38ae0dcda7 |
| INI-53 | logical-and | legacy/lib/buildPresetIni.js:116 | 8 | 7 | 1 | equivalent-dynamic:1 | proofs: ini-093-0046-operand-removal-8827268ecf |
| INI-54 | neq-comparison | legacy/lib/buildPresetIni.js:116 | 5 | 5 | 0 | — | every mutant killed by a recorded vector |
| INI-55 | truthiness | legacy/lib/buildPresetIni.js:116 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| INI-56 | logical-and | legacy/lib/buildPresetIni.js:120 | 8 | 7 | 1 | equivalent-dynamic:1 | proofs: ini-097-0029-equality-strictness-95ee6dec0d |
| INI-57 | neq-comparison | legacy/lib/buildPresetIni.js:120 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: ini-097-0029-equality-strictness-95ee6dec0d |
| INI-58 | truthiness | legacy/lib/buildPresetIni.js:120 | 4 | 3 | 1 | equivalent-dynamic:1 | proofs: ini-097-0016-negation-insertion-92416c7526 |
| INI-59 | if | legacy/lib/buildPresetIni.js:124 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| INI-60 | logical-and | legacy/lib/buildPresetIni.js:128 | 8 | 7 | 1 | equivalent-dynamic:1 | proofs: ini-105-0046-equality-strictness-3aad3fe817 |
| INI-61 | neq-comparison | legacy/lib/buildPresetIni.js:128 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: ini-105-0046-equality-strictness-3aad3fe817 |
| INI-62 | truthiness | legacy/lib/buildPresetIni.js:128 | 4 | 3 | 1 | equivalent-dynamic:1 | proofs: ini-105-0016-negation-insertion-4335515730 |
| INI-63 | logical-and | legacy/lib/buildPresetIni.js:132 | 8 | 7 | 1 | equivalent-dynamic:1 | proofs: ini-109-0031-equality-strictness-e7858a0cab |
| INI-64 | neq-comparison | legacy/lib/buildPresetIni.js:132 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: ini-109-0031-equality-strictness-e7858a0cab |
| INI-65 | truthiness | legacy/lib/buildPresetIni.js:132 | 4 | 3 | 1 | equivalent-dynamic:1 | proofs: ini-109-0016-negation-insertion-7ddda67d1e |
| INI-66 | logical-and | legacy/lib/buildPresetIni.js:136 | 8 | 7 | 1 | equivalent-dynamic:1 | proofs: ini-113-0039-equality-strictness-963f7e7d5a |
| INI-67 | neq-comparison | legacy/lib/buildPresetIni.js:136 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: ini-113-0039-equality-strictness-963f7e7d5a |
| INI-68 | truthiness | legacy/lib/buildPresetIni.js:136 | 4 | 3 | 1 | equivalent-dynamic:1 | proofs: ini-113-0016-negation-insertion-ef47a60491 |
| INI-69 | if | legacy/lib/buildPresetIni.js:140 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| INI-70 | truthiness | legacy/lib/buildPresetIni.js:141 | 1 | 1 | 0 | — | every mutant killed by a recorded vector |
| INI-71 | logical-nullish | legacy/lib/buildPresetIni.js:141 | 2 | 0 | 2 | equivalent-dynamic:2 | proofs: ini-118-0062-boolean-operator-ef0077864a, ini-118-0062-operand-removal-9e8db5af62 |
| INI-72 | logical-and | legacy/lib/buildPresetIni.js:145 | 22 | 21 | 1 | equivalent-static:1 | proofs: ini-122-0064-equality-strictness-ed5829e7da |
| INI-73 | truthiness | legacy/lib/buildPresetIni.js:145 | 14 | 14 | 0 | — | every mutant killed by a recorded vector |
| INI-74 | logical-and | legacy/lib/buildPresetIni.js:145 | 19 | 18 | 1 | equivalent-static:1 | proofs: ini-122-0064-equality-strictness-ed5829e7da |
| INI-75 | neq-comparison | legacy/lib/buildPresetIni.js:145 | 17 | 16 | 1 | equivalent-static:1 | proofs: ini-122-0064-equality-strictness-ed5829e7da |
| INI-76 | neq-comparison | legacy/lib/buildPresetIni.js:145 | 17 | 16 | 1 | equivalent-static:1 | proofs: ini-122-0101-equality-strictness-9d1921e933 |
| INI-77 | logical-and | legacy/lib/buildPresetIni.js:147 | 11 | 10 | 1 | equivalent-dynamic:1 | proofs: ini-124-0032-equality-strictness-766865ca88 |
| INI-78 | neq-comparison | legacy/lib/buildPresetIni.js:147 | 5 | 4 | 1 | equivalent-dynamic:1 | proofs: ini-124-0032-equality-strictness-766865ca88 |
| INI-79 | range-comparison | legacy/lib/buildPresetIni.js:147 | 6 | 6 | 0 | — | every mutant killed by a recorded vector |
| INI-80 | if | legacy/lib/buildPresetIni.js:150 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| INI-81 | if | legacy/lib/buildPresetIni.js:153 | 4 | 4 | 0 | — | every mutant killed by a recorded vector |
| INI-82 | logical-or | legacy/lib/buildPresetIni.js:160 | 30 | 28 | 2 | equivalent-dynamic:1 equivalent-static:1 | proofs: ini-137-0039-equality-strictness-eb22505630, ini-137-0043-string-literal-fa4ffae0e8 |
| INI-83 | neq-comparison | legacy/lib/buildPresetIni.js:160 | 27 | 25 | 2 | equivalent-dynamic:1 equivalent-static:1 | proofs: ini-137-0039-equality-strictness-eb22505630, ini-137-0043-string-literal-fa4ffae0e8 |
| INI-84 | truthiness | legacy/lib/buildPresetIni.js:160 | 24 | 24 | 0 | — | every mutant killed by a recorded vector |
| INI-85 | if | legacy/lib/buildPresetIni.js:162 | 2 | 2 | 0 | — | every mutant killed by a recorded vector |
| INI-86 | neq-comparison | legacy/lib/buildPresetIni.js:163 | 6 | 5 | 1 | equivalent-static:1 | proofs: ini-140-0043-equality-strictness-2269a656a8 |
| INI-87 | range-comparison | legacy/lib/buildPresetIni.js:164 | 7 | 6 | 1 | equivalent-dynamic:1 | proofs: ini-141-0037-relational-boundary-1f30eddadb |
| INI-88 | if | legacy/lib/buildPresetIni.js:167 | 10 | 10 | 0 | — | every mutant killed by a recorded vector |
| INI-89 | logical-and | legacy/lib/buildPresetIni.js:172 | 13 | 12 | 1 | equivalent-static:1 | proofs: ini-149-0071-equality-strictness-6073f375ae |
| INI-90 | range-comparison | legacy/lib/buildPresetIni.js:172 | 6 | 6 | 0 | — | every mutant killed by a recorded vector |
| INI-91 | neq-comparison | legacy/lib/buildPresetIni.js:172 | 7 | 6 | 1 | equivalent-static:1 | proofs: ini-149-0071-equality-strictness-6073f375ae |
| INI-92 | logical-and | legacy/lib/buildPresetIni.js:178 | 10 | 10 | 0 | — | every mutant killed by a recorded vector |
| INI-93 | neq-comparison | legacy/lib/buildPresetIni.js:178 | 5 | 5 | 0 | — | every mutant killed by a recorded vector |
| INI-94 | neq-comparison | legacy/lib/buildPresetIni.js:178 | 7 | 6 | 1 | equivalent-static:1 | proofs: ini-155-0067-equality-strictness-60cab77f69 |
| INI-95 | neq-comparison | legacy/lib/buildPresetIni.js:180 | 3 | 3 | 0 | — | every mutant killed by a recorded vector |
| INI-96 | ternary | legacy/lib/buildPresetIni.js:181 | 3 | 3 | 0 | — | every mutant killed by a recorded vector |

## Survivors worth reading

| survivor | class | region | rows | status | evidence |
|---|---|---|---|---|---|
| M-args-012-0027-relational-boundary-067339c491 | relational-boundary | args | BA-34 | equivalent-dynamic | 27 probes, product 27 |
| M-args-028-0060-equality-strictness-69a83a6367 | equality-strictness | args | BA-39 BA-41 | equivalent-dynamic | 26 probes, product 26 |
| M-args-028-0086-string-literal-62150ea11c | string-literal | args | BA-38 BA-42 | equivalent-dynamic | 26 probes, product 26 |
| M-args-032-0078-equality-strictness-4a7242bf03 | equality-strictness | args | BA-44 BA-46 | equivalent-dynamic | 27 probes, product 27 |
| M-args-032-0113-string-literal-a6729af193 | string-literal | args | BA-43 BA-47 | equivalent-dynamic | 27 probes, product 27 |
| M-args-036-0082-equality-strictness-74a02e4885 | equality-strictness | args | BA-49 BA-51 | equivalent-dynamic | 26 probes, product 26 |
| M-args-036-0119-string-literal-56cf1131a1 | string-literal | args | BA-48 BA-52 | equivalent-dynamic | 26 probes, product 26 |
| M-args-053-0031-relational-boundary-c05d2a130d | relational-boundary | args | BA-56 | equivalent-dynamic | 27 probes, product 27 |
| M-args-118-0028-equality-strictness-f3851f0e66 | equality-strictness | args | BA-77 BA-78 | equivalent-dynamic | 27 probes, product 27 |
| M-args-123-0039-string-literal-73e321f73d | string-literal | args | BA-67 BA-80 BA-81 | equivalent-dynamic | 18954 probes, product 18954 |
| M-args-127-0033-relational-boundary-a8471235f6 | relational-boundary | args | BA-85 | equivalent-dynamic | 702 probes, product 702 |
| M-args-170-0027-equality-strictness-8e1cacedfd | equality-strictness | args | BA-100 BA-101 | equivalent-dynamic | 130 probes, product 130 |
| M-config-004-0038-operand-removal-17d0e57dcf | operand-removal | config | BA-7 | equivalent-dynamic | 27 probes, product 27 |
| M-config-007-0040-operand-removal-88866c23a5 | operand-removal | config | BA-13 | equivalent-dynamic | 27 probes, product 27 |
| M-config-012-0070-operand-removal-e7cec54bcb | operand-removal | config | BA-23 | equivalent-dynamic | 26 probes, product 26 |
| M-config-017-0046-operand-removal-50b72c86f8 | operand-removal | config | BA-27 | equivalent-dynamic | 27 probes, product 27 |
| M-config-024-0058-operand-removal-8776a536a7 | operand-removal | config | BA-29 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-025-0031-equality-strictness-6a45602833 | equality-strictness | ini | INI-7 INI-8 | equivalent-dynamic | 130 probes, product 130 |
| M-ini-039-0028-equality-strictness-7799d22852 | equality-strictness | ini | INI-14 INI-15 | equivalent-dynamic | 27 probes, product 27 |
| M-ini-047-0064-equality-strictness-5c4c65bcf3 | equality-strictness | ini | INI-21 INI-23 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-051-0082-equality-strictness-6527f51eda | equality-strictness | ini | INI-26 INI-28 | equivalent-dynamic | 27 probes, product 27 |
| M-ini-055-0086-equality-strictness-2bc2f7aaae | equality-strictness | ini | INI-31 INI-33 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-059-0027-equality-strictness-9e4b7e73fb | equality-strictness | ini | INI-35 INI-36 | equivalent-dynamic | 27 probes, product 27 |
| M-ini-063-0031-equality-strictness-949aaa70d2 | equality-strictness | ini | INI-38 INI-39 | equivalent-dynamic | 27 probes, product 27 |
| M-ini-067-0031-equality-strictness-88fc97f65e | equality-strictness | ini | INI-41 INI-42 | equivalent-dynamic | 27 probes, product 27 |
| M-ini-085-0016-negation-insertion-2169033dfd | negation-insertion | ini | INI-49 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-085-0035-equality-strictness-b7c77e3e63 | equality-strictness | ini | INI-47 INI-48 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-089-0016-negation-insertion-38ae0dcda7 | negation-insertion | ini | INI-52 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-089-0039-equality-strictness-fce0d5c541 | equality-strictness | ini | INI-50 INI-51 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-093-0046-operand-removal-8827268ecf | operand-removal | ini | INI-53 | equivalent-dynamic | 27 probes, product 27 |
| M-ini-097-0016-negation-insertion-92416c7526 | negation-insertion | ini | INI-58 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-097-0029-equality-strictness-95ee6dec0d | equality-strictness | ini | INI-56 INI-57 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-105-0016-negation-insertion-4335515730 | negation-insertion | ini | INI-62 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-105-0046-equality-strictness-3aad3fe817 | equality-strictness | ini | INI-60 INI-61 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-109-0016-negation-insertion-7ddda67d1e | negation-insertion | ini | INI-65 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-109-0031-equality-strictness-e7858a0cab | equality-strictness | ini | INI-63 INI-64 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-113-0016-negation-insertion-ef47a60491 | negation-insertion | ini | INI-68 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-113-0039-equality-strictness-963f7e7d5a | equality-strictness | ini | INI-66 INI-67 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-118-0062-boolean-operator-ef0077864a | boolean-operator | ini | INI-71 | equivalent-dynamic | 27 probes, product 27 |
| M-ini-118-0062-operand-removal-9e8db5af62 | operand-removal | ini | INI-71 | equivalent-dynamic | 27 probes, product 27 |
| M-ini-124-0032-equality-strictness-766865ca88 | equality-strictness | ini | INI-77 INI-78 | equivalent-dynamic | 26 probes, product 26 |
| M-ini-137-0043-string-literal-fa4ffae0e8 | string-literal | ini | INI-82 INI-83 | equivalent-dynamic | 702 probes, product 702 |
| M-ini-141-0037-relational-boundary-1f30eddadb | relational-boundary | ini | INI-87 | equivalent-dynamic | 702 probes, product 702 |

## Vector-weakness rows

Rows whose mutants were not all killed, ranked by survivors. A row is only weak where the
survivors are gaps: a proven-equivalent survivor is the vectors being right, not thin.
The `action` column is what feeds the promotion loop.

| row | kind | mutants | killed | survivors | gap survivors | action |
|---|---|---|---|---|---|---|
| BA-67 | eq-comparison | 47 | 45 | 2 | 0 | none — every survivor carries an equivalence proof |
| BA-80 | logical-or | 38 | 36 | 2 | 0 | none — every survivor carries an equivalence proof |
| BA-81 | neq-comparison | 35 | 33 | 2 | 0 | none — every survivor carries an equivalence proof |
| INI-71 | logical-nullish | 2 | 0 | 2 | 0 | none — every survivor carries an equivalence proof |
| INI-82 | logical-or | 30 | 28 | 2 | 0 | none — every survivor carries an equivalence proof |
| INI-83 | neq-comparison | 27 | 25 | 2 | 0 | none — every survivor carries an equivalence proof |
| BA-100 | logical-and | 8 | 7 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-101 | eq-comparison | 5 | 4 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-13 | logical-or | 3 | 2 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-23 | logical-or | 5 | 4 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-27 | logical-or | 3 | 2 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-29 | logical-or | 3 | 2 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-34 | range-comparison | 7 | 6 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-38 | logical-or | 12 | 11 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-39 | logical-and | 9 | 8 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-41 | neq-comparison | 7 | 6 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-42 | eq-comparison | 7 | 6 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-43 | logical-or | 12 | 11 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-44 | logical-and | 9 | 8 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-46 | neq-comparison | 7 | 6 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-47 | eq-comparison | 7 | 6 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-48 | logical-or | 12 | 11 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-49 | logical-and | 9 | 8 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-51 | neq-comparison | 7 | 6 | 1 | 0 | none — every survivor carries an equivalence proof |
| BA-52 | eq-comparison | 7 | 6 | 1 | 0 | none — every survivor carries an equivalence proof |

(87 rows have a surviving mutant; 0 of them have at least one gap. Full list in `run.json` under `rows`.

## Reproducibility of the run itself

- `results/<class>.jsonl` is an append-only verdict journal (one line per mutant, flushed per
  mutant) plus `results/verification.jsonl` for the tier-control re-checks. A restart skips any
  mutant id whose recorded verdict carries the same mutated-source sha256, so an interrupted
  run resumes instead of repeating; `--rerun` ignores the journal and re-measures everything.
- Two independent `--rerun` passes produced byte-identical `run.json` apart from `runtime_ms`;
  `mutants.json` is byte-identical across `--dump` passes; the proof set is identical across
  `--recompute` passes.

## Promotions applied

`APPLIED.json` — 6 killing input(s) promoted into `fixtures/vectors/boundary/shrunk-mutation.jsonl` with `fixtures/goldens/boundary/shrunk-mutation.goldens.jsonl` and 104 row claim(s) in `fixtures/vectors/coverage-promotions.json` (`equivalence.js --verify` merges that map; `coverage-map.json` stays `gen-vectors.js` output). Append-only: no existing fixture line was rewritten.

| promoted vector | kills | class | rows credited | shrunk |
|---|---|---|---|---|
| shrunk-mutation-probe-0272 | M-args-137-0039-numeric-literal-3baaf26df7 | numeric-literal | 65 | 33 field(s) dropped |
| shrunk-mutation-probe-0163 | M-ini-149-0043-numeric-literal-d479f9603b | numeric-literal | 8 | no — ini channel |
| shrunk-mutation-probe-0026 | M-ini-155-0033-equality-strictness-d0d635d9c8 | equality-strictness | 2 | no — ini channel |
| shrunk-mutation-probe-0025 | M-ini-157-0047-equality-strictness-f5ab958a60 | equality-strictness | 1 | no — ini channel |
| shrunk-mutation-probe-0003 | M-ini-004-0043-loop-first-iteration-591318a098 | loop-first-iteration | 14 | no — ini channel |
| shrunk-mutation-probe-0026-f653f8fa | M-ini-081-0032-equality-strictness-56f653f8fa | equality-strictness | 14 | no — ini channel |


## Gates

- [ ] mutant enumeration is deterministic — two enumerate() passes produce identical bytes (470680) and equal the committed mutants.json
- [x] every BA/INI row carries >=1 mutant or a note — 189 in-generator rows all carry mutants; 9 rows are outside both generators and carry the note `launch prelude`
- [x] survivors == proofs/ 1:1 — 58 survivors, 58 proof files, 0 stale proof(s) pruned
- [x] unresolved gaps are escalated, never called equivalent — 0 unresolved gap(s), 0 with an ESCALATION.md entry
- [x] every survivor carries a machine-written proof object — 58 proof objects, each with a static argument or an explicit probe scope
- [x] kill check reproduces the recording harness — 2752 vectors x 2 channels unmutated, 0 disagreement(s) (asserted inside every run, not only in --selftest)
- [x] a promoted killer kills the mutant it was promoted for — 6 vector(s) in fixtures/vectors/boundary/shrunk-mutation.jsonl carrying 104 row claim(s); 6 formerly surviving mutant(s) are now killed by permanent boundary vectors; 0 gap(s) could not be promoted, 0 promoted file(s) gen-goldens.js manifest() does not list

## What feeds back

- `PROMOTIONS-PROPOSED.json`: 0 vector(s) that separate a surviving mutant from the baseline. Not applied here: fixtures are
  hash-pinned and being re-recorded, so the parent appends them under
  `fixtures/vectors/boundary/promotion-mutation-*.jsonl`, adds them to `coverage-map.json`,
  and regenerates goldens. Until then the gap stays visible in this report, not hidden.
- `proofs/<survivor-id>.json`: 58 file(s), one per survivor, each naming
  the static argument or the exact probe domain, so the Auditor can re-prove without
  re-deriving anything (plan §5).


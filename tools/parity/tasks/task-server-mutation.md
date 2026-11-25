# TASK: score the server region (plan §2 Phase 4 teeth; blocked on a kill channel + a supervisor ruling)

STATUS **enumerated-unrun**. Supervisor ruling 2026-11-25 keeps server mutants OUT of the shipped
inventory: `tools/parity/reports/mutation/mutants.json` is scored through the argv/ini/save channels
and none of them reaches a route, so a scored run would print `survived` where the truth is
`unmeasured`. `mutate.js` therefore enumerates the region into a separate artifact and
`--dump-server` asserts the `M-server-` ids never appear in `mutants.json`. READ FIRST: that
artifact, AUDIT-2026-11-25 finding 10, tools/parity/reports/mutation/REPORT.md "Regions the gate
does not score", fixtures/NEGATIVES.md (its L1 row is a hand-carried server edit, not inventory).

INPUTS: `tools/parity/reports/mutation/SERVER-REGION-ENUMERATION.json` — 152 mutants over 47 of the
49 `SV-*` rows of `SPEC/SPEC-ROWS.csv` (11 classes; conditional-inversion 17, string-literal 88,
numeric-literal 15, negation-insertion 14, boolean-operator 6, operand-removal 6, branch-swap 2,
relational 2, equality 2), region = whole `parity-baseline:server.js` (681 lines), 0 mutants rejected
by the parse gate, byte-identical rerun. Reproduce with `node tools/parity/mutate.js --dump-server`.

BUILD:
1. A KILL CHANNEL FIRST, mutants second. Options, in the order that costs least: (a) start the
   sandbox app with the mutated `server.js` (tests/L1-backend/lib/sandbox.js materialises a ref/dir;
   `--ref <dir>` already exists) and score the mutant by the L1 HTTP/socket bytes it changes —
   152 mutants x a subset of the L1 corpus, sequential, manager port 7837 is single-tenant (Q11);
   (b) L4's differential as the scorer — MEASURED NOT USABLE for argv-shaped mutants (a mangled `-m`
   committed as side A gave 27 fields per side and `diffs=0`; see fixtures/NEGATIVES.md "Open gap").
2. Fix the removal classes while you are in there: `bodyStatements()` only recognises the generator
   emit shapes (`args.push(`, `presetContent +=`, `specTypes.push(`, `sectionName =`), so **zero**
   statement-removal / loop-body-removal mutants exist for this region even though routes emit
   through `res.json` / `io.emit`. Adding those shapes is an enumerator change, and it will move the
   152.
3. Two `error-path` rows do not resolve by shape (`.catch (err)`, `catch ()` — SPEC-ROWS elides the
   arrow body and the empty block); they are recorded in `totals.rows_without_a_site`. Either teach
   `spanInLine` the elision or fix the two snippets in the CSV under a ledger entry.
4. Nondeterminism is the reason this is not a one-evening job: route responses carry PIDs, uptimes
   and wall-clock. `fixtures/COMPARISON.json` already declares which fields are `shape`-compared;
   a server mutant must be scored only on fields the policy says are `exact`, or the kill check
   measures noise.
5. WHEN A CHANNEL EXISTS: add `server` to `regionSources()`, re-score with
   `node tools/parity/mutation-run.js` + `node tools/parity/equiv-prove.js` (kill or prove every
   mutant, no gap), delete the `M-server-` guard in `mutate.js --dump-server`, and hand the
   `mutants.json` / `run.json` / `REPORT.md` change to the supervisor as its own ledger entry — all
   three are pinned (C8) and this task may not regenerate them on its own authority.

GATES: (a) the enumeration stays byte-identical across `--dump-server` reruns; (b) no `M-server-` id
in `mutants.json` until step 5 lands; (c) no server mutant is called killed, survived or equivalent
without the channel in step 1 — an unscored mutant is reported as unscored; (d) the existing L1
negative control (`SV-get-settings-3-string-literal`, red as `L1.SETTINGS.FIRST-RUN.BYTES`) stays
green-as-named, because it is the only server-region claim the suites make today.

OWNERSHIP: tools + reports only. `fixtures/**`, `tests/**`, `PARITY.md`, `AGENTS.md` are not yours
(C8); a `mutants.json` or `SPEC-ROWS.csv` change goes through the ledger holder.

# SPEC-ROWS — AST predicate inventory (Phase 2 item 2)

`SPEC/SPEC-ROWS.csv` is the completeness checklist for Part 1. It is generated, never
hand-edited. Line coverage is not the checklist; this row set is (plan.md §2 Phase 2 item 2).

```
node tools/parity/ast-inventory.js            # regenerate SPEC/SPEC-ROWS.csv + print the summary
node tools/parity/ast-inventory.js --check     # exit 1 if a rerun differs (byte-identical guard)
node tools/parity/ast-inventory.js --selftest  # exit 1 if counts / locs / flag cross-check fail
```

Sources parsed with `acorn` (`ecmaVersion: latest`, `locations: true`); `public/script.js` is
parsed as a module (`import { io }`), `server.js` as a script. The tool tries `script` first and
falls back to `module`, so the choice is derived from the source, not hardcoded.

## Regions and how they are located

Region roots are found **by function / handler name, never by line numbers** — the inventory
survives any edit to the legacy sources. If a root disappears the tool fails loudly.

| prefix | region root | file | rows |
|---|---|---|---|
| `BA` | `launchServer` (the inline buildArgs region, plan §2) | public/script.js | 102 |
| `INI` | `launchModelPresets` (the inline buildPresetIni region) | public/script.js | 96 |
| `SCV` | `saveCurrentValues` | public/script.js | 28 |
| `LC` | `loadConfiguration` | public/script.js | 56 |
| `DC` | `deleteConfiguration` | public/script.js | 2 |
| `SV-<method>-<path>` | each `app.<method>('<path>', handler)` registration | server.js | 48 |
| `SV-ws-connection` | `io.on('connection', handler)` | server.js | 1 |

Total **333** rows. Per-route counts: `SV-post-start` 5, `SV-post-stop` 8, `SV-get-models` 1,
`SV-get-status` 3, `SV-post-restart` 12, `SV-get-settings` 3, `SV-post-settings` 8,
`SV-post-launch-presets` 8, `SV-ws-connection` 1, `SV-get-root` / `SV-get-swagger` /
`SV-get-metrics` 0 (these three handlers contain no predicate — they still need contract tests,
which the CSV cannot express).

The whole function body is the region, including nested callbacks (`forEach`, `stdout.on`,
`setTimeout`), so a branch inside a route's process-event handler is inventoried.

**Not inventoried** (outside the coverage list this task was given, recorded here so the gap is
visible rather than silent): `server.js` `getSystemMetrics`, `updateSystemMetricsHistory`,
`findGGUFFiles`, and every `public/script.js` function other than the five named above
(`fetchModels`, `showOutput`, `renderConfigList`, `updateDraftModelVisibility`, the chart
functions, `openSettingsDialog`, …). Rows for those are a deliberate scope decision for the
supervisor, not an omission of the scanner.

## How a row_id is minted

1. Region roots are discovered by name; regions are emitted in the table order above, and
   server routes in source order.
2. Inside a region every node is collected, then **sorted by `(node.start, node.end, kind rank)`**
   — pure source order. The row number is `index + 1`, contiguous from 1 with no gaps
   (`--selftest` asserts contiguity, so a re-run that reordered anything fails).
3. `row_id = <prefix>-<n>`. Ids are stable across runs and across edits that do not reorder
   source; `--check` guarantees the committed CSV is byte-reproducible.

## Columns

`row_id, file, line, fn_or_route, kind, code_snippet, vars_read, targets`

* `line` — acorn's own `loc.start.line` for the row's node. `--selftest` re-derives the line from
  the node byte-offset and fails on any mismatch, and re-derives `code_snippet` from the node's
  source span (per `snippetFrom`), so a row cannot drift away from its node.
* `fn_or_route` — region label (`launchServer`, `POST /start`, `WS connection`).
* `code_snippet` — the predicate text only (an `if` row carries `if (<test>)` / `else if (<test>)`,
  never the body), whitespace-collapsed, ≤220 chars.
* `vars_read` — `;`-separated static member chains read by the condition, in source order,
  deduplicated. Calls appear as `parseInt()`, `Number.isNaN()`; the *arguments* of a call are
  collected as separate entries. DOM reads are recorded with the element id literal:
  `document.getElementById('parallel').value` → `#parallel.value`, and a top-level
  `const x = document.getElementById('y')` alias is annotated as `nglInput(#ngl).value`.
* `targets` — first-level effects the branch controls, `;`-separated. `else:`-prefixed entries are
  the alternate branch. Rules: `args.push` → `args.push` plus `args.push:<flag literal>`;
  `presetContent += \`temp = ${…}\`` → `presetContent:temp = ` (this is how ini keys become
  greppable); assignment lhs → `x.y`; `.status(400)` → `res.status(400)`; `return`; `throw`;
  `delete x.y` → `delete x.y`; `console.*` is ignored. Nested branch bodies, blocks and function
  bodies are *not* first level — they get their own rows. Never truncated silently: the ceilings
  (`MAX_TARGETS` 40, `MAX_VARS` 24 / 400 chars) are asserted by `--selftest`.

## kind vocabulary

| kind | node the row points at | meaning |
|---|---|---|
| `if` | IfStatement | branch gated on a bare truthiness test |
| `else-if` | IfStatement in an `alternate` position | same, marked in the snippet |
| `ternary` | ConditionalExpression | three-way value fork |
| `logical-or` / `logical-and` / `logical-nullish` | LogicalExpression (`if` rows inherit the kind of their test) | short-circuit operator = boolean-operator mutation site |
| `eq-comparison` / `neq-comparison` / `range-comparison` | comparison BinaryExpression | relational operator mutation site (`==/===`, `!=/!==`, `< > <= >=`) |
| `truthiness` | bare operand of `&&`/`||`/`??` (after stripping leading `!`) | operand flip site |
| `loop-gate` | loop node (`for`, `for-in`, `for-of`, `while`, `do-while`) | iteration gate; snippet is the loop header |
| `switch-case` | SwitchCase with a test | (none present today; `default` is not a predicate) |
| `error-path` | CatchClause, or the callback of `promise.catch(cb)` | error branch, incl. the empty `catch {}` that causes Q2 |

Suppression rules that keep the set non-redundant, all machine-applied:
a comparison/logical node that *is* the direct test of an `if` gets no separate row (the `if` row
carries its kind); literal/constant operands (`|| 0`) are not predicates; a bare test of an
`if`/loop/ternary is not re-emitted as `truthiness`; `!!x` records one flip site (`x`).

## What `--selftest` asserts

* two consecutive in-process runs produce byte-identical CSV (nondeterminism guard, `--check`
  extends it to the committed file)
* ≥ 80 rows total, ≥ 25 rows in `BA` (actual: 333 / 102)
* every row's `line` equals acorn's loc **and** the offset-derived line; every snippet is
  reconstructible from its node's source span
* `row_id` unique, contiguous, source-ordered per region; every region located by name; kinds in
  the vocabulary above; no `targets`/`vars_read` truncation
* **flag cross-check**: every `--flag`/`-flag` string literal pushed inside the `BA` region is
  named by the `targets` of the branch row that guards it (39 guarded push sites, all named).
  Pushes with no enclosing branch cannot be named by any predicate row and are reported as
  unguarded instead of skipped: `--host`, `-fit`, `--port` — the always-appended args of Q14.

## How Phase 2 vectors map onto rows

`fixtures/vectors/coverage-map.json` is the mapping artifact, keyed by `row_id`:

```json
{
  "BA-33": ["boundary-temp-0", "format-0.30000000000000004", "corpus-17"],
  "BA-83": ["boundary-spec-none-ngram-off"],
  "SV-post-start-1": ["L1-start-no-path-400"]
}
```

* one entry per row_id in `SPEC-ROWS.csv`; value = list of vector ids (ids as recorded in
  `fixtures/vectors/**`, each vector id resolvable to a vector file)
* a vector may cover many rows; a row may need many vectors (each `targets` entry / `vars_read`
  name is a separate flip dimension, so `logical-and` rows typically need one vector per operand
  plus one for the combined-false case)
* the Part 1 gate is *every row mapped by ≥ 1 vector*; the checker enumerates `SPEC-ROWS.csv`
  row ids and fails on any missing or empty entry, and on any map key that is not a row id
  (typo protection). The map is a `fixtures/` artifact: Verifier-owned, hash-pinned, Builder may
  not edit it (AGENTS.md role boundaries)
* rows listed as dead below are mapped too — recorded, not dropped (C2). If a dead row cannot be
  reached by any vector, the ledger row carries the machine-written equivalence proof instead of
  a vector id.

## Suspected DEAD predicates (flagged per C2, still in the CSV, none dropped)

| row(s) | location | why suspected dead |
|---|---|---|
| BA-83 | script.js:597 `if (specTypes.length > 0)` | the outer guard BA-78 (`speculationType !== 'none' \|\| ngramMod`) is exactly `specTypes.length > 0`; the false branch is unreachable |
| INI-85 | script.js:834 `if (specTypes.length > 0)` | same construction in the ini generator |
| INI-69 | script.js:811 `config.fastAttention ?? 'auto'` | guard INI-67 requires `config.fastAttention` truthy, and `null`/`undefined` are falsy → `'auto'` can never be chosen |
| LC-38 | script.js:320 `config.specDraftNMax && …` | the conjunct cannot change the outcome — `config.specDraftNMax > 0` is already false for `undefined`/`0`/`NaN` (mutant-equivalent) |
| LC-40 | script.js:322 `else if (config.ngramMod)` | both this branch and its `else` assign `'none'`; the predicate is behaviorally dead |
| BA-30 | script.js:474 `if (config.modelPath)` | BA-3 (`if (!modelPathSelect.value.trim()) { alert; return; }`) already guarantees the same expression is truthy |
| SCV-26 | script.js:248 `chatTemplateKwargsInput ? … : ''` | `#chatTemplateKwargs` is static markup (index.html:286), so the `''` alternate is unreachable |
| SV-post-stop-5/6/7 | server.js:371 | `runningProcess = null` (server.js:376) runs synchronously before the 1 s timer fires → the **SIGKILL path never runs for `/stop`**; if a new process was spawned within that second it kills the *new* one. Contradicts the L1 expectation "SIGTERM → 1 s → SIGKILL"; ledger-relevant |
| SV-post-restart-6/7/8 | server.js:441 | same timer, but `/restart` nulls `runningProcess` (server.js:446) and then spawns a new process synchronously → the pending timer SIGKILLs the process it just started. Reachable only over HTTP (the client restart path is dead code per §9), quirk to port as-is |
| SV-post-stop-2, SV-post-restart-3 | server.js:368 / 438 | the `runningProcess &&` conjunct is always true at that point (the handler's first guard already returned when it was falsy) |
| SV-post-start-3/4, SV-post-restart-10/11, SV-post-launch-presets-6/7 | `if (runningProcess.stdout)` / `.stderr` | `spawn(…, { stdio: 'pipe' })` always yields both streams → false branch unreachable (6 rows) |
| SV-post-start-5 | server.js:348 `catch` | `spawn` throws only for a non-string executable path; a missing binary surfaces as an `error` event, so this handler is near-dead (reachable with a non-string truthy `serverPath` in the body) |
| SV-get-models-1 | server.js:397 `catch` | `findGGUFFiles` catches every internal failure and never rejects → near-dead |
| BA-96/97, INI-78/79, BA-52 | `if (config.ctkd)` / `ctvd` / `config.loadMode` | always truthy for a normal UI session (no empty `<option>`), but a retired saved enum value blanks the `<select>` (Q18) — alive, narrowly; needs corpus vectors to prove it |

Dead rows stay in the CSV and must still be mapped or proven equivalent; per C2 they are
**recorded**, not ported blindly.

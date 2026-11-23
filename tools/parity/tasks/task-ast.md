# TASK: AST predicate inventory -> SPEC/SPEC-ROWS.csv (Phase 2 item 2)

Repo C:/projects/Cline-demo. READ FIRST: plan.md (§2 Phase 2, §9 quirks table, §11), AGENTS.md.
`npm install --save-dev acorn acorn-walk` (you are the only worker allowed to touch package.json right now).

WRITE (touch nothing else besides package.json/lock from that install; do NOT git commit):
1. tools/parity/ast-inventory.js — parses public/script.js and server.js with acorn (sourceType script for script.js if needed, ecmaVersion latest) and emits SPEC/SPEC-ROWS.csv, one row per PREDICATE/BRANCH:
   columns: row_id, file, line, fn_or_route, kind, code_snippet, vars_read, targets
   - Coverage: EVERY if/conditional/ternary/logical-shortcircuit binary (|| ?? &&)/comparison/loop-condition/switch-case INSIDE: buildArgs region (launchServer 409-650), buildPresetIni region (launchModelPresets 676-870), saveCurrentValues, loadConfiguration, deleteConfiguration, and EVERY route callback in server.js (each branch of each route fn incl. try/catch blocks as kind=error-path).
   - kind examples: if, ternary, logical-or, eq-comparison, range-comparison, truthiness, catch, loop-gate, switch-case.
   - row_id stable+readable: `BA-{n}` buildArgs region, `INI-{n}` preset-ini region, `SCV-{n}`, `LC-{n}`, `DC-{n}`, `SV-{route}-{n}`. Numbering = source order, deterministic across runs (byte-identical rerun is a hard requirement).
   - vars_read: identifiers the condition reads (for DOM reads like getElementById('x').value record the element id literal too).
   - targets: what the branch guards (first-level: what flag/assignment/return it controls) — extract heuristically (e.g. consequent contains args.push('--flag') => '--flag'); empty allowed.
   - The region boundaries must be located by function name (launchServer, launchModelPresets, saveCurrentValues, loadConfiguration, deleteConfiguration) NOT hardcoded line numbers.
2. `--check` mode: fail (exit 1) if a rerun differs from the committed CSV (nondeterminism guard); `--selftest`: asserts counts > thresholds (e.g. >=80 rows total; BA region >=25 incl. every `--flag` string literal in region has >=1 row whose targets mentions it — implement that flag cross-check for real), and asserts every row's line matches the acorn-reported loc exactly for its node.
3. Also write SPEC/SPEC-ROWS.md: how row ids are minted + how Phase 2 vectors map onto rows (matrix file fixtures/vectors/coverage-map.json will reference row_id; just define format here: {row_id: [vector_id,...]}).

Run selftest until green. Report: total rows per prefix, top-10 most complex rows (vars_read count), and any predicate you suspect is DEAD (unreachable from UI) flagged per C2 — list them, do not drop them.

# tests/L2-ui — L2 UI conformance suite

Checks the **rendered page** against expectations recorded from `parity-baseline`. Nothing here
imports app code at node level (gate `L2-NO-APP-IMPORTS`): the browser fetches the app itself from a
`--ref` sandbox of static assets, and every backend call is replayed from recorded bytes. The manager
process never runs — this is pure L2 (plan §6 rule 1, task §"UI MOCK").

## Running

```bash
node tests/L2-ui/run.js                                   # one run vs parity-baseline
node tests/L2-ui/run.js --only corpus-list,corpus-launch   # subset by check name
node tests/L2-ui/run.js --list                             # check names
node tests/L2-ui/run.js --repeat 2                         # same suite twice (flake probe)
node tests/L2-ui/run.js --verify-selftest --repeat 2       # the gate: 100% green vs legacy assets
node tests/L2-ui/record-inputs.js --port 7853              # re-record goldens/resave/inputs.jsonl
```

`--ref` (default `parity-baseline`) selects the git ref whose `public/` is served; the sandbox is
extracted with `git ls-tree` + `git cat-file` into `C:\parity-l2\app` and marked with `.l2-ref`, so a
stale sandbox for a different ref is never reused. `--port`, `--out` (default `tests/L2-ui/out`,
gitignored), `--scratch`, `--refresh` (drop the cached sandbox) round out the flags. A failing
assertion prints its id, the claim, expected, actual and a JSON-pointer-ish `at:` line.

## Layout

| path | owns |
|---|---|
| `run.js` | check registry, page/context lifecycle, report + `DISAGREEMENTS.md`, self-test gate |
| `record-inputs.js` | records `fixtures/goldens/resave/inputs.jsonl` from the baseline page (browser-side inputs for the `resave` golden family) |
| `helpers/page.js` | ref sandbox extraction + static server (socket-error tolerant: Playwright aborts requests) |
| `helpers/mocks.js` | fetch router replaying `fixtures/http` raw bytes, `io()` stub, `POST /start` capture |
| `helpers/browser.js` | page open (seed, fake clock, viewport, dialog capture), field/option dumps, localStorage seeding (once per context) |
| `helpers/fixtures.js` | fixture readers + corpus/resave golden access + `screenshotMetrics()` |
| `helpers/render.js` | element fingerprint (geometry, control state, digit-masked text) |
| `helpers/assert.js` | result recorder + structural diff with first-difference reporting |
| `checks/*.js` | the assertions (see map below) |

Unmatched fetch is a failure (`L2-MOCK-unmatched-fetch`), a static asset that 404s is a failure
(`L2-STATIC-404`), and the page must request the `io` stub (`L2-SOCKET-module-requested`).
`GET /status` can be routed as the recorded idle/running **pair** (`statusPair: true`) so a launched
page stays launched while it is being asserted; that switch is driven by the page's own
`POST /start` / `POST /stop`, not by the check.

## Assertion inventory (green run vs `parity-baseline`)

433 assertions per run; groups as printed by the runner:

| group | count | file |
|---|---|---|
| `fields` | 56 | `checks/fields.js` |
| `conditional-ui` | 96 | `checks/conditional.js` + `checks/storage.js` (conditional UI, CRUD, localStorage, Q7/Q8/Q16) |
| `log-pane` | 18 | `checks/runtime.js` |
| `socket-events` | 11 | `checks/runtime.js` |
| `http-mock` | 4 | `checks/runtime.js` |
| `cadence` | 5 | `checks/runtime.js` |
| `charts` | 4 | `checks/runtime.js` |
| `dialogs` | 7 | `checks/runtime.js` |
| `state-snapshots` | 30 | `checks/states.js` |
| `corpus` | 181 | `checks/corpus.js` |
| `misc` | 21 | `checks/misc.js`, plus the three harness gates `run.js` emits (`L2-SOCKET-module-requested`, `L2-NO-APP-IMPORTS`, `L2-STATIC-404`) |

## Quirk map (plan §9 / PARITY.md)

| quirk | L2 assertions | expectation source |
|---|---|---|
| **Q1** Restart rendered, permanently disabled | `L2-Q1-restartBtn` (`disabledAttr` **and** `.disabled`), plus the per-state pages `L2-Q1-fresh`, `-config-selected`, `-running`, `-settings-dialog`, `-stopped`, `-after-delete-prompt`; `#restartBtn` also appears in all 10 `L2-STATE-*` / `L2-A11Y-*` fingerprints | `fixtures/screenshots/**.render.json`, `index.html` markup |
| **Q5** `--port` from `settings.serverPort`, `DEFAULT_PORT` 8080 on `/launch-presets` | `L2-PORT-default-posted`, `L2-PORT-default-8080`, `L2-PORT-argv-tail`, `L2-Q7-launch-port-from-settings` | recorded `fixtures/http/J5-ui-launch` bodies + pinned baseline argv slice |
| **Q7** `saveCurrentValues` ≠ `launchServer` field sets; launch re-reads the DOM | `L2-Q7-launch-posts`, `L2-Q7-argv-reads-dom`, `L2-Q7-argv-serverPath-not-a-flag`, `L2-Q7-body-keys`, `L2-Q7-saved-field-set`, `L2-Q7-saved-has-serverPath-and-kwargs`, `L2-Q7-resave-on-launch` | `tools/parity/baseline-slices.js` (`saveCurrentValues` + argv slices), `fixtures/goldens/resave` |
| **Q8** `deleteConfiguration` partial reset to a hard-coded list | `L2-Q8-every-control` (all 41 values), `L2-Q8-reset-only-list`, `L2-Q8-reset-values`, `L2-Q8-reset-misses`, `L2-Q8-loadMode-divergence` (`mlock` → `mmap`, i.e. the value that is **not** reset), `L2-Q8-control-count` | recorded reset list in `deleteConfiguration()` (baseline slice), `fixtures/localstorage` |
| **Q9** `fastAttention` `<select>` read via `.value`, `auto` → bare `-fa` | `L2-FIELD-fastAttention`, argv vectors per config in `L2-CORPUS-argv-*` | recorded argv |
| **Q10** ini key names + trailing `port = ` | `L2-INI-all48-bytes`, `L2-INI-all48-per-section`, `L2-INI-all48-section-order`, `L2-INI-body-keys`, `L2-INI-trailing-port`, `L2-INI-pane-before-port-line`, `L2-INI-presets-dropdown`, and the 2-config subset `L2-INI-2config-*` (forward + reversed seed) | `fixtures/ini/J4b-ui-presets-launch`, `fixtures/goldens/corpus` |
| **Q12** Google Fonts `<link>`, no service worker | `L2-Q12-font-links` (URLs normalized by origin), `L2-Q12-no-service-worker` | `index.html` markup |
| **Q13** native `alert`/`confirm`, `location.reload()` after settings save | `L2-Q13-reload-after-settings-save`, `L2-DIALOG-*`, recorded-dialog comparison in `L2-CORPUS-Q18-alert-text` | `fixtures/screenshots/J5-ui-dialogs`, dialogs recorded by `record-inputs.js` |
| **Q14** `-fit off` and `--host 0.0.0.0` always appended | `L2-PORT-argv-tail` (exact tail order), every `L2-CORPUS-argv-*` | recorded argv |
| **Q16** orphan keys kept on load, dropped on re-save | `L2-Q16-corpus-has-orphans`, `L2-Q16-before-seed`, `L2-Q16-load-does-not-clean`, `L2-Q16-load-keeps-keys`, `L2-Q16-resave-drops-orphans`, `L2-Q16-resave-field-count`, `L2-CRUD-insertion`/`L2-Q16-*` key order | `fixtures/goldens/resave` (`saved_config`, `saved_field_order`, `ini_changes_on_resave`) |
| **Q17** ini reads `disableReasoning`, launch ignores it | `L2-CORPUS-argv-*` vs `L2-INI-all48-bytes` on the 15 affected configs (argv has no `--reasoning`, ini has `reasoning = …`); classified `iii:reasoning-from-disableReasoning(Q17)` in `DISAGREEMENTS.md` | recorded ini + argv pair |
| **Q18** saved value missing from `<option>` blanks on load | `L2-CORPUS-Q18-options`, `L2-CORPUS-Q18-blanked` (48/48 with the recorded J2 `/models` payload, `value ""`, `selectedIndex -1`), `L2-CORPUS-Q18-alert-count`, `L2-CORPUS-Q18-no-posts`, `L2-CORPUS-argv-*` (dropped flags) | `fixtures/http/J2-models/models.response`, `fixtures/goldens/resave` `op=alert-blocked` |
| **Q19** stored number vs DOM string in the `!= "0"` predicates | per-config `L2-CORPUS-argv-*` (four zero forms, four outcomes), classified `i:stored-number-vs-DOM-string(Q19)` in `DISAGREEMENTS.md` | browser argv capture vs `fixtures/goldens/corpus` |
| **Q20** paths stored verbatim, mixed separators | `L2-CORPUS-serverPath-*` (the POST body is the stored string, `\` and `/` untouched) | corpus storage + captured POST bodies |
| **Q21** truthy-but-broken paths emitted as-is | `L2-CORPUS-argv-Qwen 3 Q4 64K - Draft` and `L2-CORPUS-argv-Qwen3-coder-480b-draft`: `draftModelPath` ends in `undefined` and reaches argv as `-md` with no validation | recorded argv |
| **Q22** `topK: -1`, `ngl: 0/100`, `topP: 0` follow the §9 predicates | every `L2-CORPUS-argv-*` (all 48 configs) | recorded argv |
| **Q11** (`serverPort` never moves the manager port), **Q2**, **Q3**, **Q4**, **Q6** | not L2 claims — backend behaviour, owned by `tests/L1-backend`. L2 only asserts the client half: the `--port` value the page posts (`L2-PORT-*`), and a `200` body with `success:false` rendering as `L2-START-error-line` instead of updating the status | corpus storage, `fixtures/http/J5-ui-launch` |

UI-structure claims that are not quirks: `L2-FIELDS-*` (41 SPEC fields, recorded 38-control fresh
page), `L2-FIELD-<id>` per field (type/default/min/max/step/options/label/section), `L2-HEADINGS-*`
(section order), `L2-SPEC-*` (draft-section visibility per `speculationType`), `L2-CTK-*` and
`L2-KVARN-*` (conditional rows and KVarN warnings), `L2-CRUD-*` (empty state, create, alphabetical
render, active class, edit, delete, orphan keys), `L2-MODELS-*` (dropdown population and the
`/models` failure line), `L2-PRESETS-*`, `L2-LOG-*` (ISO shape, per-chunk `.trim()`, 1000-line cap,
auto-scroll, byte replay of `fixtures/ws` payloads), `L2-SOCKET-*` (recorded event order,
`server-ended`/`error`, stop disconnect), `L2-CADENCE-*` (`/status` 5 s and `/metrics` 1 s under fake
timers, independent timers), `L2-CHART-*` (canvas draw, resize, 50-point history, readouts),
`L2-STATE-*` / `L2-A11Y-*` (rendered + a11y fingerprint per state), `L2-INI-*`. The ini-order claim covers all 48 configs (`L2-INI-all48-section-order`, storage insertion
order while the list renders alphabetically) **and** a deterministic 2-config subset seeded forward
and reversed (`L2-INI-2config-*`), so the order divergence is proved with a minimal pair as well.

## Where the expectations come from

- **HTTP**: `fixtures/http/<journey>/<name>.response` raw bytes, matched on exact URL + query. The
  `/start` and `/stop` routes also capture what the page posted.
- **WebSocket**: `io()` is stubbed by `helpers/mocks.js`; `fixtures/ws/<journey>/events.json` payloads
  are replayed byte-for-byte through the stub (chunk boundaries preserved, because the pane's
  per-chunk `.trim()` is part of the claim).
- **Storage seeds**: `fixtures/localstorage/**` and `fixtures/corpus/configs.remapped.json` (48
  configs, paths remapped at record time).
- **Launch/re-save expectations**: `fixtures/goldens/resave/goldens.jsonl`, composed by
  `tools/parity/gen-goldens.js` from `fixtures/goldens/resave/inputs.jsonl` (browser-side state
  recorded from `parity-baseline` by `record-inputs.js`) plus the pinned baseline slices in
  `tools/parity/baseline-slices.js`. `L2-CORPUS-form-sha-*` re-proves the page is in the recorded
  state (`launch_form_sha256`) before comparing argv.
- **Corpus argv/ini**: `fixtures/goldens/corpus/goldens.jsonl` (generator side) and the recorded
  browser argv (DOM side). Where those two disagree the browser is the truth and the disagreement is
  reported, not reconciled — see `DISAGREEMENTS.md`.
- **Screenshots**: only `*.render.json` / `*.a11y.json` are compared (`fixtures/COMPARISON.json`
  rule `screenshot-pixels` makes the PNG informational). Rendered fingerprints are written to
  `tests/L2-ui/out/screenshots/` for inspection; pixel diffing is the Auditor phase.
  The fingerprint pages serve `helpers/fixtures.js#screenshotMetrics` — the canned `/metrics` body
  named by `capture-legacy.js` — because the recorded readout digits are part of the geometry claim.
  `logPane.startsWithTimestamp` is masked **only** in the capped J5-ui-cap fingerprint with the
  `<chunk-boundary>` digit-masking idiom, and replaced by the deterministic `anyEntryTimestamped`
  claim, per the `2026-11-23 RESOLVED` ledger entry at PARITY.md:59; the 9 uncapped fingerprints keep
  the real boolean.

## DISAGREEMENTS.md

`run.js` writes `out/DISAGREEMENTS.md` (and `out/disagreements.json` with the full argv pairs) from
three probes: the SPEC field pack vs the rendered control, the SPEC source text vs the rendered
template, and the browser-captured corpus argv vs `fixtures/goldens/corpus`. 28 of 48 configs
disagree with the generator-side golden; each is classified
`i:stored-number-vs-DOM-string(Q19)`, `ii:loadMode-migration-from-mlock/noMmap/dio(Q16)`,
`iii:reasoning-from-disableReasoning(Q17)`, `iv:speculationType-…`,
`v:draftModelPath-blanking(Q18)`. These rows are for the SPEC/CONSISTENCY follow-up: no golden or
assertion was moved to make them pass (C4), and `fixtures/goldens/corpus` is untouched.

## Flakes

The suite runs the page under fake timers only where the claim is a timer (cadence, charts); clock
frozen pages also freeze `Date`, so log timestamps are deterministic. Fake timers are never combined
with a wait on a mock capture. localStorage is seeded once per browser context so checks that reload
the page (Q13) do not re-seed. Known nondeterminism is masked at the fingerprint level, never by
weakening an exact assertion; `--repeat N` is the flake probe and a flake is fixed or quarantined with
traces, never skipped.

# fixtures/vectors — input families for the two pure generators

Every vector is one fully-specified input to `buildArgs` and `buildPresetIni`. Goldens
(`fixtures/goldens/`) are the baseline's output for those inputs. Nothing here encodes a belief about
what the output should be: inputs are generated, outputs are recorded from
`git show parity-baseline:public/script.js` (plan §2 Phase 2.3-2.5, C4, C5).

```
node tools/parity/gen-vectors.js          regenerate vectors/** + coverage-map.json + coverage-exceptions.json
node tools/parity/gen-vectors.js --check  fail if the committed vectors are not what a rerun produces
node tools/parity/gen-goldens.js          record fixtures/goldens/** + MANIFEST.json from parity-baseline
node tools/parity/gen-goldens.js --check  fail if the committed goldens are not what a rerun produces
node tools/parity/equivalence.js          candidate (legacy/lib) vs goldens; any diff is a candidate bug
node tools/parity/equivalence.js --verify coverage reality check over SPEC/SPEC-ROWS.csv
node tools/parity/equivalence.js --selftest mutate the lib in memory, prove the gate notices (<60 s)
node tools/parity/equivalence.js --full    every mutation site against every vector, tiered (~10 s)
```

`MANIFEST.json` carries the sha256 of every file here and in `fixtures/goldens/`, plus the exact
command that regenerates it. `gen-goldens.js --check` recomputes those hashes and fails on a file that
is on disk but not listed, so the manifest is enforced rather than asserted.

## Paths: `SCRATCH_ROOT` and `FIXTURE_ROOT`

Model paths in vectors come from recorded `/models` payloads, which live under the capture machine's
scratch root. That root is replaced by the token `SCRATCH_ROOT` on the **input** side (vectors,
`INPUTS.json`); the corpus configs already arrive as `FIXTURE_ROOT` from `PATH-MAP.json`. Neither
token is expanded anywhere — the generators treat a path as an opaque string except for the
`--chat-template-file` derivation, which keys on separators, so tokenizing cannot change which branch
runs. Alongside the tokenized paths, boundary keeps literal username-free absolute paths
(`C:/parity-fixture/models/a/model-a.gguf` and its `\` twin) so raw paths and the Q20 separator pair
are still exercised in untokenized form. Goldens are the baseline's bytes for the tokenized inputs, so
no file under `fixtures/` carries a personal path.

## Layout

| Path | Contents |
|---|---|
| `boundary/vectors.jsonl` | the §9/§9A quirk vectors, plus one synthesized vector per predicate flip the inventory can express |
| `cover/vectors.jsonl` | 2-wise over the whole field matrix, 3-wise over the speculation cluster |
| `format/vectors.jsonl` | the plan §2.3 format probes, through both generators |
| `random/vectors.jsonl` | 1500 seeded vectors (seed in the header line) |
| `corpus/vectors.jsonl` | the 48 remapped real saved configs, verbatim |
| `INPUTS.json` | the field matrix and value classes, the recorded settings sets and `/models` sets, the reference fields |
| `coverage-map.json` | `row_id -> [vector_id]` over the BA/INI rows of `SPEC/SPEC-ROWS.csv` |
| `coverage-exceptions.json` | rows no vector can reach, and the reason; vectors with no row, and the reason |
| `boundary/shrunk-*.jsonl` | minimal repros promoted by `equivalence.js --shrink` after a real failure; absent while the gate is green |
| `coverage-promotions.json` | `row_id -> [shrunk_vector_id]` for those repros, merged by `--verify`; it never rewrites `coverage-map.json`, which is `gen-vectors.js` output |
| `MANIFEST.json` | sha256 + regen command for every vectors and goldens file |

## Vector line

```json
{"kind":"vector","id":"boundary-minp-0.00","family":"boundary","name":"boundary-minp-0.00",
 "targets":["BA-42","INI-24"],"targets_via":"flip","fields":{...},"settings":"settings-1",
 "models":"recorded","note":"Q19 minP zero form \"0.00\""}
```

* `fields` is the **saved-config shape** — stored types kept (`0` next to `"0.00"`, Q19), orphan keys
  kept (Q16), absent keys absent (the `config.X !== undefined` domain). This is the shape
  `buildPresetIni` receives and the shape `localStorage` holds.
* The **argv** input is derived from it the way the app derives it: `loadConfiguration` fills the
  form, then `launchServer` reads the DOM (Q7). So keys absent from `fields` fall back to the
  recorded fresh-page state (`reference_fields` in `INPUTS.json`), never to an invented default.
* `ini_configs` (optional) overrides the ini input entirely — used for the zero-section case.
* `settings` / `models` are ids of **recorded** sets in `INPUTS.json` (`settings_sets` carry the
  8080/7838 split of Q5; `model_sets` are recorded `/models` payloads so an mmproj flag in a golden
  is a recorded association).
* `targets` are `SPEC-ROWS.csv` row ids. `targets_via` is `flip` (this vector's outcome for the row
  differs from the reference's) or `exercise` (it flips nothing, but it evaluates the row's test with
  a different value of a field the row reads — the format probes live here, their assertion is the
  emitted bytes).

## Golden line

```json
{"kind":"golden","vector_id":"boundary-minp-0.00","impl":"parity-baseline@<sha>",
 "argv":["-ngl","99",...],"ini":"dmVyc2lvbiA9IC4uLg=="}
```

`argv` is the **ordered array** — order is part of the contract. `ini` is base64 of the exact bytes
the generator returns. The trailing `port = ${settings.serverPort}` line is **not** in those bytes: at
baseline it is appended after `showOutput`, and it is not in `legacy/lib/buildPresetIni.js` either, so
including it would make the golden test something other than the generator.

`argv`/`ini` are `null` with `argv_threw`/`ini_threw` set when the baseline generator throws. That is
recorded, not avoided: `buildPresetIni` has no guard on `config.modelPath.replace` behind
`if (config.loadCustomChatTemplate)`, so a saved config with the checkbox on and no `modelPath`
crashes it, and `launchModelPresets` prints `'Error launching model presets: ' + error.message` into
the log pane. The message is user-visible output, so the candidate must reproduce it (C4).

## Reference vector

`boundary-default` is the recorded fresh-page form state. Every flip is measured against it, and it is
the opposite-side witness for each flippable row, which is why it appears in `coverage-map.json`.

## Evaluation identity

Both generators are pure functions of `(name, fields, settings, models, ini_configs)`, and equivalence
caches evaluations on exactly that tuple. `name` belongs in the key: `buildPresetIni` writes one
section per config key, so two vectors with identical fields (`boundary-ba-6-false` and
`boundary-ba-7-false`) must not share an answer. Dropping it makes results depend on which vector was
evaluated first — a subset run would then disagree with a full run for reasons that have nothing to do
with the candidate. Any vector here can be evaluated in isolation; `--family <family>` is green only
because of this.

## Teeth

`--selftest` patches the two baseline slices in memory (nothing is written to disk) at 13 sites, each
anchored to one exact string; an anchor that no longer matches exactly once fails the gate rather than
silently disappearing. It runs on a fixed sample — every boundary and corpus vector plus a
deterministic stride from each generated family — so it stays a sub-minute gate. `--full` gives every
site the same prefix first and only spends the whole corpus on sites the prefix could not kill; a kill
is idempotent, so skipping killed sites is sound. `--full --family <family>` is the incremental form.

When a site survives everything, that is the finding: the corpus stopped proving the branch. It is
fixed by adding vectors, never by dropping the site.

## Shrinking

A failure is reduced by differential delta debugging: a probe is accepted only while the candidate
still disagrees with the **baseline on that probe**, and only while the probe is strictly smaller.
Comparing a probe against its parent vector's golden would be wrong the moment the probe differs from
its parent — the parent's golden is simply the wrong answer for a different input — and an
earlier version that did that, and re-tried every settings and model set each pass, never terminated.

## Exceptions are recorded, never dropped (C2)

`coverage-exceptions.json` lists, with reasons:

* `unreachable-domain` — rows outside both generators (the `launchServer`/`launchModelPresets`
  preludes: `if (!serverPath)`, `if (data.success)`, the `catch` clauses), and rows whose predicate
  takes one value for every input the generators accept (mutation-equivalent branches, plan §2 item 6).
* `duplicate-of-reference` — a probe value the fresh page already holds (e.g. `minP "0"`), kept
  because the plan's probe list names it; it asserts nothing beyond the reference.
* `rowless-vector` — a vector that changes only the always-appended args (`--host 0.0.0.0`, `-fit off`,
  `--port`), which `SPEC-ROWS.md` records as **unguarded** pushes no predicate row can name.

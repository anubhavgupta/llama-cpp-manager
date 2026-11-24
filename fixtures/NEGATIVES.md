# NEGATIVES — recorded negative controls for the Part-1 suites

Written by `node tools/parity/negative-controls.js --all`. The rows below are that run's
recorded output, not hand-authored assertions (rule C5). Each row applies ONE mutant from
`tools/parity/reports/mutation/mutants.json` to a scratch git worktree of `parity-baseline`,
runs the narrowest check group that should see it, then reverts the worktree. A mutant is
never committed and never touches this checkout's `public/script.js`.

Reproduce one row (each patch is a `git diff` of the scratch worktree):

```sh
git worktree add --detach C:/parity-scratch/repro/checkout parity-baseline
git -C C:/parity-scratch/repro/checkout apply tools/parity/reports/negatives/<id>.patch
# from this repo, run the command in the Command column of that row
git -C C:/parity-scratch/repro/checkout checkout -- .   # revert
git worktree remove --force C:/parity-scratch/repro/checkout
```

| mutant | region / class | edit | Command | red assertion | verdict |
|---|---|---|---|---|---|
| `M-args-005-0022-string-literal-97ddd1c464` | args / string-literal | "'-m'" -> "'-mX'" | `node tests/L3-seam/run.js --app C:/parity-scratch/negatives/M-args-005-0022-string-literal-97ddd1c464/checkout --only models,argv --keep-scratch` | `L3.ARGV-recorded-bytes` | RED-AS-NAMED |
| `M-args-171-0026-string-literal-6e65569a1d` | args / string-literal | "'--mmproj'" -> "'--mmprojX'" | `node tests/L3-seam/run.js --app C:/parity-scratch/negatives/M-args-171-0026-string-literal-6e65569a1d/checkout --only models,argv --keep-scratch` | `L3.ARGV-mmproj-from-window-models` | RED-AS-NAMED |
| `M-args-004-0012-conditional-inversion-3d525bcf46` | args / conditional-inversion | "config.modelPath" -> "!(config.modelPath)" | `node tests/L3-seam/run.js --app C:/parity-scratch/negatives/M-args-004-0012-conditional-inversion-3d525bcf46/checkout --only corpus-seed,corpus-launch --keep-scratch` | `L3.CORPUS-argv-goldens` | RED-AS-NAMED |
| `M-ini-004-0043-loop-first-iteration-591318a098` | ini / loop-first-iteration | "Object.entries(configs)" -> "Object.entries(configs).slice(0, 1)" | `node tests/L3-seam/run.js --app C:/parity-scratch/negatives/M-ini-004-0043-loop-first-iteration-591318a098/checkout --only corpus-seed,corpus-launch --keep-scratch` | `L3.CORPUS-INI-bytes` | RED-AS-NAMED |
| `M-ini-020-0033-string-literal-9df5bbb505` | ini / string-literal | "`model = ${config.modelPath}\\n`" -> "`model = ${config.modelPath}\\nX`" | `node tests/L3-seam/run.js --app C:/parity-scratch/negatives/M-ini-020-0033-string-literal-9df5bbb505/checkout --only corpus-seed,corpus-tokens --keep-scratch` | `L3.CORPUS-INI-token-bytes` | RED-AS-NAMED |
| `M-config-004-0013-negation-insertion-619719c0b5` | config / negation-insertion | "parseInt(nglInput.value)" -> "!(parseInt(nglInput.value))" | `node tests/L3-seam/run.js --app C:/parity-scratch/negatives/M-config-004-0013-negation-insertion-619719c0b5/checkout --only models,argv --keep-scratch` | `L3.ARGV-recorded-bytes` | RED-AS-NAMED |

## What each row proves

- **M-args-005-0022-string-literal-97ddd1c464** (L3) — the argv builder emits a mangled `-m` flag: the argv jsonl bytes written through the real spawn path for the recorded launch stop matching the recorded bytes
  Red: `L3.ARGV-recorded-bytes`; exit 1. Full log: `tools/parity/reports/negatives/M-args-005-0022-string-literal-97ddd1c464.log`. Patch: `tools/parity/reports/negatives/M-args-005-0022-string-literal-97ddd1c464.patch`.
- **M-args-171-0026-string-literal-6e65569a1d** (L3) — the `--mmproj` flag is emitted as `--mmprojX`: the association between the selected model and its mmproj file, taken from the live /models scan, leaves argv
  Red: `L3.ARGV-mmproj-from-window-models`; exit 1. Full log: `tools/parity/reports/negatives/M-args-171-0026-string-literal-6e65569a1d.log`. Patch: `tools/parity/reports/negatives/M-args-171-0026-string-literal-6e65569a1d.patch`.
- **M-args-004-0012-conditional-inversion-3d525bcf46** (L3) — the model-path guard is inverted, so no config pushes its `-m` model: the 48-config argv goldens lose the model argument on every launch
  Red: `L3.CORPUS-argv-goldens`; exit 1. Full log: `tools/parity/reports/negatives/M-args-004-0012-conditional-inversion-3d525bcf46.log`. Patch: `tools/parity/reports/negatives/M-args-004-0012-conditional-inversion-3d525bcf46.patch`.
- **M-ini-004-0043-loop-first-iteration-591318a098** (L3) — the ini builder writes only the first saved config: the composed 48-section models-preset.ini bytes stop matching the recorded corpus ini
  Red: `L3.CORPUS-INI-bytes`; exit 1. Full log: `tools/parity/reports/negatives/M-ini-004-0043-loop-first-iteration-591318a098.log`. Patch: `tools/parity/reports/negatives/M-ini-004-0043-loop-first-iteration-591318a098.patch`.
- **M-ini-020-0033-string-literal-9df5bbb505** (L3) — every `model = ` line in the generated ini gains a trailing X: the token-form corpus ini bytes — the ones that carry the Q20 mixed-separator chat-template-file lines — stop matching the recorded bytes
  Red: `L3.CORPUS-INI-token-bytes`; exit 1. Full log: `tools/parity/reports/negatives/M-ini-020-0033-string-literal-9df5bbb505.log`. Patch: `tools/parity/reports/negatives/M-ini-020-0033-string-literal-9df5bbb505.patch`.
- **M-config-004-0013-negation-insertion-619719c0b5** (L3) — `ngl: parseInt(nglInput.value) || 0` becomes `!(parseInt(...)) || 0`, so the collected ngl collapses to 0 and `--n-gpu-layers` leaves the command line: the recorded argv jsonl bytes from the real spawn path differ. The `config` region is the LAUNCH value collector, not the localStorage writer — see the coverage note below.
  Red: `L3.ARGV-recorded-bytes`; exit 1. Full log: `tools/parity/reports/negatives/M-config-004-0013-negation-insertion-619719c0b5.log`. Patch: `tools/parity/reports/negatives/M-config-004-0013-negation-insertion-619719c0b5.patch`.

## Layer coverage, and the gaps this inventory cannot close

Rows above cover L3. They cannot cover **L1**: every region in
`mutants.json` is a `public/script.js` generator region (`args`, `ini`, `config`), and L1
drives the manager over HTTP with no browser, so no mutant in that inventory can reach an
L1 assertion. Proving L1 has teeth needs a `server.js` region in the mutation inventory,
which is verifier-owned tooling — recorded here as an open gap rather than papered over
with an L1 row that would not be a real mutant.

A second gap, measured rather than assumed: the inventory has **no region for the
localStorage writer**. `config` is the launch value collector, so no inventory mutant can
change re-saved bytes. Measured with
`node tools/parity/negative-controls.js --probe M-config-004-0013-negation-insertion-619719c0b5 --layer L3 --only corpus-seed,corpus-resave --expect L3.CORPUS-resave-bytes`,
which re-saved all 48 configs byte-identical to the goldens with `ngl` collapsed to 0, and
the same mutant on `--only models,argv`, which reddened `L3.ARGV-recorded-bytes`. That is
why the `config` row above targets argv. Closing the gap needs a `saveCurrentValues`
region (`ANCHORS.SAVE_START`) added to the mutation inventory.

A third gap, also measured: dropping the ini's `mmproj = ` line
(`M-ini-026-0037-string-literal-ec533f9648`) reddened `L3.CORPUS-INI-token-bytes` when the
scratch tree still held the mmproj files the recording left behind, and went undetected
(exit 0, check passing) after `C:/parity-scratch/fixtures` was rebuilt from
`tools/parity/fixture-tree.sh`. The token-form ini only carries an mmproj line when the
live /models scan reports an mmproj association, so that part of the claim is vacuous on a
rebuilt tree — the row above uses a `model = ` line mutant, which is present on every
config. L3 has a vacuity guard for the Q20 separator lines
(`L3.CORPUS-INI-Q20-VACUOUS`) but none for mmproj association; adding one is L3 work.

Two rows share `L3.ARGV-recorded-bytes` on purpose: it is the byte-exact claim that gives
the argv builder its teeth, and a mangled flag, an inverted guard and a changed collected
value all have to land there.

Each control rebuilds the fixture tree first (`fixture-tree.sh <tree> clean`), because every
control shares the suite's recording-root scratch and a corpus check materialises 48 model
files into it — without the reset, a later row would also go red on claims whose inputs
its mutant never touched. The full child output of each row is in its .log file.

A row reading `MUTANT-SURVIVED` means the suites did not notice a behaviour change they
claim to pin; per plan §7 that check group is then rewritten, not the mutant.

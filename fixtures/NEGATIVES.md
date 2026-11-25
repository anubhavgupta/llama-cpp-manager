# NEGATIVES — recorded negative controls for the Part-1 suites

Written by `node tools/parity/negative-controls.js --all`. The rows below are that run's
recorded output, not hand-authored assertions (rule C5). Each row applies ONE behaviour
change to a scratch git worktree of `parity-baseline`, runs the narrowest check group that
should see it, then reverts the worktree. Six rows take a recorded mutant from
`tools/parity/reports/mutation/mutants.json`; the `server` row carries its own edit, because
the server region is enumerated but not in that inventory (see
`tools/parity/reports/mutation/SERVER-REGION-ENUMERATION.json`). A mutant is
never committed and never touches this checkout's `public/script.js`.

Reproduce one row (each patch is a `git diff` of the scratch worktree):

```sh
git worktree add --detach C:/parity-scratch/repro/checkout parity-baseline
git -C C:/parity-scratch/repro/checkout apply tools/parity/reports/negatives/<id>.patch
# from this repo, run the command in the Command column of that row
git -C C:/parity-scratch/repro/checkout checkout -- .   # revert
git worktree remove --force C:/parity-scratch/repro/checkout
```

| mutant | layer / region / class | edit | Command | red assertion | verdict |
|---|---|---|---|---|---|
| `M-args-005-0022-string-literal-97ddd1c464` | L3 args / string-literal | "'-m'" -> "'-mX'" | `node tests/L3-seam/run.js --app C:/parity-scratch/negatives/M-args-005-0022-string-literal-97ddd1c464/checkout --only models,argv --keep-scratch` | `L3.ARGV-recorded-bytes` | RED-AS-NAMED |
| `M-args-171-0026-string-literal-6e65569a1d` | L3 args / string-literal | "'--mmproj'" -> "'--mmprojX'" | `node tests/L3-seam/run.js --app C:/parity-scratch/negatives/M-args-171-0026-string-literal-6e65569a1d/checkout --only models,argv --keep-scratch` | `L3.ARGV-mmproj-from-window-models` | RED-AS-NAMED |
| `M-args-004-0012-conditional-inversion-3d525bcf46` | L3 args / conditional-inversion | "config.modelPath" -> "!(config.modelPath)" | `node tests/L3-seam/run.js --app C:/parity-scratch/negatives/M-args-004-0012-conditional-inversion-3d525bcf46/checkout --only corpus-seed,corpus-launch --keep-scratch` | `L3.CORPUS-argv-goldens` | RED-AS-NAMED |
| `M-ini-004-0043-loop-first-iteration-591318a098` | L3 ini / loop-first-iteration | "Object.entries(configs)" -> "Object.entries(configs).slice(0, 1)" | `node tests/L3-seam/run.js --app C:/parity-scratch/negatives/M-ini-004-0043-loop-first-iteration-591318a098/checkout --only corpus-seed,corpus-launch --keep-scratch` | `L3.CORPUS-INI-bytes` | RED-AS-NAMED |
| `M-ini-020-0033-string-literal-9df5bbb505` | L3 ini / string-literal | "`model = ${config.modelPath}\\n`" -> "`model = ${config.modelPath}\\nX`" | `node tests/L3-seam/run.js --app C:/parity-scratch/negatives/M-ini-020-0033-string-literal-9df5bbb505/checkout --only corpus-seed,corpus-tokens --keep-scratch` | `L3.CORPUS-INI-token-bytes` | RED-AS-NAMED |
| `M-config-004-0013-negation-insertion-619719c0b5` | L3 config / negation-insertion | "parseInt(nglInput.value)" -> "!(parseInt(nglInput.value))" | `node tests/L3-seam/run.js --app C:/parity-scratch/negatives/M-config-004-0013-negation-insertion-619719c0b5/checkout --only models,argv --keep-scratch` | `L3.ARGV-recorded-bytes` | RED-AS-NAMED |
| `SV-get-settings-3-string-literal` | L1 server / string-literal | ".lmstudio" -> ".lmstudiX" | `node tests/L1-backend/run.js --verify-against-selftest --ref <throwaway-commit> --only contract --keep-scratch` | `L1.SETTINGS.FIRST-RUN.BYTES` | RED-AS-NAMED |
| `M-args-005-0022-string-literal-97ddd1c464` | L2 args / string-literal | "'-m'" -> "'-mX'" | `node tests/L2-ui/run.js --ref C:/parity-scratch/negatives/M-args-005-0022-string-literal-97ddd1c464/checkout --port 7866 --out C:\parity-scratch\negatives/M-args-005-0022-string-literal-97ddd1c464/l2out --only corpus-launch` | `L2-CORPUS-argv-Qwen` | RED-AS-NAMED |

## What each row proves

- **M-args-005-0022-string-literal-97ddd1c464** (L3) — the argv builder emits a mangled `-m` flag: the argv jsonl bytes written through the real spawn path for the recorded launch stop matching the recorded bytes
  Red: `L3.ARGV-recorded-bytes`; exit 1. Full log: `tools/parity/reports/negatives/M-args-005-0022-string-literal-97ddd1c464-l3.log`. Patch: `tools/parity/reports/negatives/M-args-005-0022-string-literal-97ddd1c464-l3.patch`.
- **M-args-171-0026-string-literal-6e65569a1d** (L3) — the `--mmproj` flag is emitted as `--mmprojX`: the association between the selected model and its mmproj file, taken from the live /models scan, leaves argv
  Red: `L3.ARGV-mmproj-from-window-models`; exit 1. Full log: `tools/parity/reports/negatives/M-args-171-0026-string-literal-6e65569a1d-l3.log`. Patch: `tools/parity/reports/negatives/M-args-171-0026-string-literal-6e65569a1d-l3.patch`.
- **M-args-004-0012-conditional-inversion-3d525bcf46** (L3) — the model-path guard is inverted, so no config pushes its `-m` model: the 48-config argv goldens lose the model argument on every launch
  Red: `L3.CORPUS-argv-goldens`; exit 1. Full log: `tools/parity/reports/negatives/M-args-004-0012-conditional-inversion-3d525bcf46-l3.log`. Patch: `tools/parity/reports/negatives/M-args-004-0012-conditional-inversion-3d525bcf46-l3.patch`.
- **M-ini-004-0043-loop-first-iteration-591318a098** (L3) — the ini builder writes only the first saved config: the composed 48-section models-preset.ini bytes stop matching the recorded corpus ini
  Red: `L3.CORPUS-INI-bytes`; exit 1. Full log: `tools/parity/reports/negatives/M-ini-004-0043-loop-first-iteration-591318a098-l3.log`. Patch: `tools/parity/reports/negatives/M-ini-004-0043-loop-first-iteration-591318a098-l3.patch`.
- **M-ini-020-0033-string-literal-9df5bbb505** (L3) — every `model = ` line in the generated ini gains a trailing X: the token-form corpus ini bytes — the ones that carry the Q20 mixed-separator chat-template-file lines — stop matching the recorded bytes
  Red: `L3.CORPUS-INI-token-bytes`; exit 1. Full log: `tools/parity/reports/negatives/M-ini-020-0033-string-literal-9df5bbb505-l3.log`. Patch: `tools/parity/reports/negatives/M-ini-020-0033-string-literal-9df5bbb505-l3.patch`.
- **M-config-004-0013-negation-insertion-619719c0b5** (L3) — `ngl: parseInt(nglInput.value) || 0` becomes `!(parseInt(...)) || 0`, so the collected ngl collapses to 0 and `--n-gpu-layers` leaves the command line: the recorded argv jsonl bytes from the real spawn path differ. The `config` region is the LAUNCH value collector, not the localStorage writer — see the coverage note below.
  Red: `L3.ARGV-recorded-bytes`; exit 1. Full log: `tools/parity/reports/negatives/M-config-004-0013-negation-insertion-619719c0b5-l3.log`. Patch: `tools/parity/reports/negatives/M-config-004-0013-negation-insertion-619719c0b5-l3.patch`.
- **SV-get-settings-3-string-literal** (L1) — the first-run fallback directory in GET /settings is replaced: the first-run response bytes stop matching fixtures/http/J0-baseline/settings-first-run.response. This is the route-level claim L1 owns and no client-region mutant can reach.
  Red: `L1.SETTINGS.FIRST-RUN.BYTES`; exit 1. Full log: `tools/parity/reports/negatives/SV-get-settings-3-string-literal-l1.log`. Patch: `tools/parity/reports/negatives/SV-get-settings-3-string-literal-l1.patch`.
- **M-args-005-0022-string-literal-97ddd1c464** (L2) — the `-m` flag string is mangled in the served directory: the per-config argv claims the browser suite makes over the recorded corpus go red, which also disproves the retired claim that L2 --ref cannot observe a mutated oracle
  Red: `L2-CORPUS-argv-Qwen`; exit 1. Full log: `tools/parity/reports/negatives/M-args-005-0022-string-literal-97ddd1c464-l2.log`. Patch: `tools/parity/reports/negatives/M-args-005-0022-string-literal-97ddd1c464-l2.patch`.

## Layer coverage, and the gaps this inventory cannot close

Rows above cover L1, L2, L3. L1 is covered by a server-region row: the mutation is made in a throwaway commit and handed to L1 as `--ref <commit>`, because L1 materialises its sandbox with `git archive <ref>` and will not take a dirty directory. The mutated checkout therefore lives outside the L1 suite scratch root (C:/parity-neg-l1), which that suite cleanTrees. That commit exists only for its run, so the Command column prints `--ref <throwaway-commit>` instead of a sha, and the literal command with the sha it actually used is the first line of the row's .log.

Open gap, measured 2026-11-25: the **L4** differential does not yet have a control.
The argv mutant above was committed and run as side A against a clean side B
(`--only backend`): 27 fields per side, `diffs=0`. The backend probe does not observe the
mangled flag, so an L4 row would be a red gate for the wrong reason. Closing it needs an
L4 probe whose observed fields include the launch request body, or an L4 row driven by a
save-region mutant through the `ui` probe, which does read localStorage bytes.

A second gap, measured rather than assumed and now **closed**: the inventory used to have
no region for the localStorage writer. `config` is the launch value collector, so no
inventory mutant could change re-saved bytes. Measured with
`node tools/parity/negative-controls.js --probe M-config-004-0013-negation-insertion-619719c0b5 --layer L3 --only corpus-seed,corpus-resave --expect L3.CORPUS-resave-bytes`,
which re-saved all 48 configs byte-identical to the goldens with `ngl` collapsed to 0, and
the same mutant on `--only models,argv`, which reddened `L3.ARGV-recorded-bytes`. That is
why the `config` row above targets argv. The inventory now has the `saveCurrentValues`
region (`ANCHORS.SAVE_START`), scored against the recorded re-save corpus by
`node tools/parity/mutation-run.js`; that is also why the save region needs no row here -
its kill channel is the recorded corpus, and its two fallback-branch survivors are proven
statically by `node tools/parity/equiv-prove.js`.

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

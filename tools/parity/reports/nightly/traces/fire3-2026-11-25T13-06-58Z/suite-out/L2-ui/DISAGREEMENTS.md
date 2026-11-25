# tests/L2-ui DISAGREEMENTS — where the SPEC pack / gen-goldens output is not what the browser renders

Truth is what the legacy browser rendered (plan §4 tie-break step 1). Nothing here changes a
golden or an assertion; the rows below are for the SPEC/CONSISTENCY follow-up.

Class key (supervisor-approved classification):

- `i:stored-number-vs-DOM-string(Q19)` — `fixtures/goldens/corpus` is recorded from the SAVED
  config with its stored JSON types. `minP`/`repeatPenalty`/`presencePenalty` are then compared
  with `x != "0"` and `x == "0.00"`, and when both sides are strings JS compares them as
  STRINGS: the DOM value `"0"` drops the flag while the stored number `0` emits it. Four
  zero forms, four outcomes (Q19).
- `ii:loadMode-migration-from-mlock/noMmap/dio(Q16)` — 27 configs have no `loadMode` key and
  `loadConfiguration` migrates the orphan `mlock`/`noMmap`/`dio` keys, while the golden keeps
  the fresh-form default `none`.
- `iii:reasoning-from-disableReasoning(Q17)` — 15 configs have no `reasoning` key and
  `loadConfiguration` derives `on`/`off` from the legacy `disableReasoning`; the golden leaves
  `auto`, so it emits no `--reasoning`.
- `iv:speculationType-inferred-from-specDraftNMax` — 1 config: the same migration in
  `loadConfiguration` that the generator input model does not apply.
- `v:draftModelPath-blanking(Q18)` — a saved draft path with no `<option>` blanks in the
  browser and drops `-md/-ngld/-ctkd/-ctvd`.

## field-manifest

No disagreements.

## spec-source-text-vs-rendered-template

| field | id | attribute | SPEC | rendered |
|---|---|---|---|---|
| modelsDirectory | modelsDirectory | section | "Settings dialog (built by openSettingsDialog)" | "Settings" |
| modelsDirectory | modelsDirectory | placeholder | "Enter models directory path" | "Enter models directory path" |
| modelsDirectory | modelsDirectory | defaultValue | null | "C:\\parity-scratch\\fixtures\\models" |
| serverPort | serverPort | section | "Settings dialog (built by openSettingsDialog)" | "Settings" |
| serverPort | serverPort | placeholder | "${DEFAULT_PORT}" | "8080" |
| serverPort | serverPort | defaultValue | null | "7838" |

## corpus-argv-vs-gen-goldens

Configs whose browser-captured argv differs from `fixtures/goldens/corpus`:
28 of 48.

| class | configs |
|---|---|
| `i:stored-number-vs-DOM-string(Q19)` | 19 |
| `i:stored-type(Q19)` | 1 |
| `ii:loadMode-migration-from-mlock/noMmap/dio(Q16)` | 28 |
| `iii:reasoning-from-disableReasoning(Q17)` | 15 |
| `iv:speculationType-inferred-from-specDraftNMax` | 1 |
| `iv:speculationType-other` | 3 |

| config | classes | first differing positions | argv length gen-goldens → browser |
|---|---|---|---|
| Qwen 3 Q4 64K - 28TPS | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17) | 14, 15, 16, 17, 18, 19 | 39 → 39 |
| GPT-OSS-20B 16K 125TPS | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16) | 10, 11, 12, 13, 14, 15 | 31 → 27 |
| GPT-OSS-20B 100K 52TPS | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16) | 10, 11, 12, 13, 14, 15 | 33 → 29 |
| GPT-20B 131K(full) - 50TPS | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16) | 10, 11, 12, 13, 14, 15 | 33 → 29 |
| Qwen 3 0.6b | ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17) | 15, 27, 28, 29, 30, 31 | 33 → 35 |
| Qwen 3 Q4 10K - 38TPS | i:stored-type(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16) | 14, 15, 16, 17, 18, 19 | 39 → 37 |
| Qwen3VL - 30B | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16) | 12, 13, 14, 15, 16, 17 | 39 → 37 |
| Qwen3VL-30B-Thinking | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17) | 12, 13, 14, 15, 16, 17 | 39 → 37 |
| Qwen3VL-2B | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16) | 12, 13, 14, 15, 16, 17 | 37 → 35 |
| Qwen3VL-4B | ii:loadMode-migration-from-mlock/noMmap/dio(Q16) | 19 | 37 → 37 |
| Qwen3VL-8B | ii:loadMode-migration-from-mlock/noMmap/dio(Q16) | 19 | 37 → 37 |
| Qwen 3 - 4b | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16) | 14, 15, 16, 17, 18, 19 | 37 → 35 |
| Mistral -14B Thinking | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17) | 10, 11, 12, 13, 14, 15 | 35 → 33 |
| Nvidia-orchestrator-8b | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16) | 12, 13, 14, 15, 16, 17 | 37 → 33 |
| Qwen3VL-2B-thinking | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16) | 12, 13, 14, 15, 16, 17 | 37 → 33 |
| Qwen 3 Q4 64K - Draft | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16) | 14, 15, 16, 17, 18, 19 | 39 → 37 |
| Qwen3-coder-480b | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17) | 14, 15, 16, 17, 18, 19 | 39 → 39 |
| Nemotron-3-nano | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17) | 10, 11, 12, 13, 14, 15 | 33 → 31 |
| Qwen3 - 4b Thinking | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16) | 14, 15, 16, 17, 18, 19 | 37 → 35 |
| Qwen3-coder-480b-draft | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17) | 14, 15, 16, 17, 18, 19 | 39 → 39 |
| nemotron-cascade-14b | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17)<br>iv:speculationType-other | 10, 11, 12, 13, 14, 15 | 43 → 41 |
| GLM-4.7-flash | ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17) | 13, 35, 36, 37, 38, 39 | 41 → 43 |
| Qwen3-coder-80b | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17) | 12, 13, 14, 15, 16, 17 | 39 → 37 |
| Qwen3-coder-80b-full | i:stored-number-vs-DOM-string(Q19)<br>ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17) | 12, 13, 14, 15, 16, 17 | 37 → 35 |
| qwen3.5-0.8b | ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17) | 15, 35, 36, 37, 38, 39 | 41 → 43 |
| qwen3.6-35b-mtp-n | ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17)<br>iv:speculationType-inferred-from-specDraftNMax | 19, 33, 34, 35, 36, 37 | 50 → 55 |
| qwen3.6-35b-n | ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17)<br>iv:speculationType-other | 19, 33, 34, 35, 36, 37 | 50 → 53 |
| ornith-35b | ii:loadMode-migration-from-mlock/noMmap/dio(Q16)<br>iii:reasoning-from-disableReasoning(Q17)<br>iv:speculationType-other | 19, 35, 36, 37, 38, 39 | 52 → 55 |

Full argv pairs: `out/disagreements.json`.

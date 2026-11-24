# tests/L3-seam CHECKS — what the seam suite pins

L3 is the only layer where the browser, the real manager and the fake binary are all live, so it
owns the behaviors that exist only across that boundary (plan §9 'Seam-only behaviors') plus the
corpus round-trip against a real backend. Every expectation is a recorded legacy artifact
(`fixtures/**`, compared under `fixtures/COMPARISON.json`) or a relation between values the live
legacy run produces itself. Gate: `node tests/L3-seam/run.js --verify-against-selftest` ×2.

Harness guards: `L3.NO-APP-IMPORTS` (§6.1, no `public/`, `legacy/` or `server.js` require anywhere in
the suite), `L3.CHECKS-MD` (this index), and the sandbox's port check (it refuses to kill a process
it did not start).

## checks/seam.js

| check id | pins | recorded expectation |
|---|---|---|
| `L3.SETTINGS-point-at-tree` | POST /settings aims the manager at the fixture tree | — (input, value recorded in J1/J4) |
| `L3.MODELS-fixture-bytes` | the real /models scan over the fixture tree | `http/J2-models/models.response` bytes |
| `L3.MODELS-mmproj-field` | first-match `mmproj*` association per model | `http/J2-models/models.response` |
| `L3.ARGV-recorded-bytes` | the client-built vector as the stand-in received it (2 lines/launch: relay + relayed fake) | `argv/J5-ui-launch/launch.jsonl`, rule `argv-jsonl` |
| `L3.ARGV-mmproj-from-window-models` | `--mmproj` comes from `window.models`, i.e. from the last real /models fetch | J2 model entry + J5 argv |
| `L3.ARGV-chat-template-file-separators` | Q20: `--chat-template-file` is the `\`-concatenation onto a server-returned path | `argv/J5-ui-launch/launch.jsonl` |
| `L3.ARGV-port-from-localStorage-settings` | Q5/Q11: `--port` is the localStorage value, at the recorded index, inside the fixed `--host/-fit/--port` tail | `argv/J5-ui-launch/launch.jsonl` |
| `L3.PORT-q2-resets-file-to-8080` | Q2: POST /settings without serverPort writes 8080 back | `http/J1-settings/settings-post-without-port.*` + `ini/J1-settings/settings.after-without-port.json` |
| `L3.PORT-Q11-manager-still-7837` | Q11: the settings port never moves the manager | recorded Q11 row |
| `L3.PORT-dialog-prefill-from-file` | seam split-brain: the dialog prefills from settings.json (`settings = {...settings, ...data.settings}`) while localStorage keeps 7838 | cross-value claim on this run |
| `L3.PORT-cancel-keeps-localStorage` | Q13: cancelling writes nothing | cross-value claim on this run |
| `L3.PORT-launch-takes-merged-port` | after the merge the launched argv carries the FILE port, localStorage still holds the client port | cross-value claim on this run |
| `L3.INI-presets-from-ui-bytes` | ini built in the browser, written verbatim by the server (sha of the browser-built bytes == sha of the bytes on disk), Q10 trailing `port = ` | pane vs disk, recorded J4b ordering claim |
| `L3.PORT-presets-ui-argv` | `/launch-presets` argv shape `--models-preset <file> --host 0.0.0.0 --port <body>` | `argv/J4-launch-presets/port-source-evidence.json` |
| `L3.PORT-start-vs-presets` | Q5 dual path: both launch paths carry the client port here | J5 argv + J4 evidence |
| `L3.PORT-presets-default-8080` | Q5: a body without serverPort spawns DEFAULT_PORT 8080, settings.json (8080 post-Q2) is ignored | `port-source-evidence.json` |
| `L3.PORT-presets-explicit-port` | Q5: a body with serverPort spawns that port | `port-source-evidence.json` |

## checks/corpus.js — the corpus round-trip on a real backend (plan §2, §9A)

| check id | pins | recorded expectation |
|---|---|---|
| `L3.CORPUS-materialised` | §9A remapped mode: the corpus model files are materialised so no modelPath blanks | `localstorage/J6-corpus-smoke/model-path-select-survey.json` (48 options) |
| `L3.CORPUS-list` | 48 rendered rows in the recorded legacy sort order | `localstorage/J6-corpus-smoke/config-list.json` |
| `L3.CORPUS-launched-count` | all 48 configs reach POST /start (nothing alert-blocked in resolved mode) | `goldens/resave` |
| `L3.CORPUS-argv-recorded-j6` | the first three corpus launches, byte-for-byte (6 argv-jsonl lines) | `argv/J6-corpus-smoke/launch.jsonl` |
| `L3.CORPUS-argv-goldens` | all 48 argvs positionally equal to legacy (Q7 Q18 Q19 Q20 Q21 Q22) | `goldens/resave/goldens.jsonl`, PATH-MAP-resolved |
| `L3.CORPUS-spawn-target` | every corpus spawn went to the compiled stand-in (the `.cmd` exe token resolves to it) | `argv/J5-ui-launch/probe-stand-in.json` |
| `L3.CORPUS-INI-bytes` | ini from all 48 configs, whole file and per section, section order = storage insertion order, trailing `port = ` | `goldens/corpus` + `ini/J4b-ui-presets-launch/presets-claims.json` |
| `L3.CORPUS-resave-bytes` | Q16: all 48 re-saved entries byte-identical | `goldens/resave` (`saved_config`) |
| `L3.CORPUS-resave-orphans` | Q16: orphan keys dropped for exactly the configs that carried them | `goldens/resave` (`saved_field_order`) |
| `L3.CORPUS-resave-key-order` | §9 trap 6: re-saving does not reorder the storage keys | recorded insertion order |
| `L3.CORPUS-INI-token-bytes` | Q20: token-form ini bytes match the recorded corpus ini exactly, mixed `\`/`/` chat-template-file lines included | `goldens/corpus` |
| `L3.CORPUS-Q18-alert` | Q18/Q13: a stored path with no real /models option blanks and alerts with the recorded text | `goldens/resave` (`op=alert-blocked`) |

Order matters: the `/models` byte claim is the pure fixture-tree layout, so `checks/seam.js` runs
before `checks/corpus.js`, which is what materialises the corpus model files into that tree.

# PART 1 — documentation defects a Part-2 engineer would trip on

Cold start, docs only. Severity = what it costs the Part-2 builder: **HIGH** = builds the wrong
behaviour or cannot start; **MED** = guesses a gate/constraint and may ship a red; **LOW** = noise.

## A. WRONG (a doc states something the recorded bytes contradict)

| # | Sev | Location | Defect | What I had to do |
|---|---|---|---|---|
| W1 | HIGH | `SPEC/BUILD-FROM.md:44` | "`GET /swagger.json` … not a route — the framework default 404 body is what the recording holds". The recording holds the swagger file body (`fixtures/http/J0-baseline/swagger-json.response` = `{ "openapi": "3.0.3", …`), i.e. `express.static('public')` answers **200 + file bytes**; `SPEC/api-contract.md:19` also says 200. | Trusted neither doc line; opened the recording. A builder who trusts BUILD-FROM ships a 404. |
| W2 | HIGH | `SPEC/api-contract.md:13` | Route table gives `GET /restart` statuses **200**, contradicting `SPEC/api-contract.md:29` ("express answers the default 404 page") and `PARITY.md` Q23 ("GET /restart is Express 404, not app JSON"); recorded bytes are the Express `Cannot GET /restart` HTML page. Self-contradiction inside one SPEC view. | Read the recording + `server.js:427` registration order. |
| W3 | MED | `SPEC/BUILD-FROM.md:37` (+ table `:41-53`), `plan.md:89` | Route count is three different numbers for one contract: BUILD-FROM "The manager has 11 routes" with **no `GET /settings` row** (a live route, `server.js:539`, present in `SPEC/api-contract.md:16`) but a row for the non-route `/swagger.json`; `plan.md:89` says L1 covers "all 9 endpoints"; `SPEC/api-contract.md` lists 13 path rows. | Counted registrations in `server.js` myself (11 real routes incl. `GET /settings`). |
| W4 | MED | `README.md:11` | "PWA, can be installed as a desktop app" vs `SPEC/BUILD-FROM.md:28` / Q12: **no** service worker, **no** offline support (L2 has asset/DOM tests for this). The repo's front-page description invites the exact unrequested "improvement" C1 forbids. | Assumed Q12 wins (AGENTS says PARITY is authoritative) but had to reason it out. |
| W5 | LOW | `README.md:17` | "Start the server: `node run start`" — not a command. `package.json:6` is `node server.js`. | Ignored. |
| W6 | LOW | `SPEC/BUILD-FROM.md:98` | Cites `SPEC/CONSISTENCY.md#auto-resolutions`; the heading is `## Auto-resolutions — recorded evidence beats a source read` (`SPEC/CONSISTENCY.md:33`), so the anchor resolves to nothing. | Text search. |

## B. STALE (doc describes a repo state that no longer exists)

| # | Sev | Location | Defect |
|---|---|---|---|
| S1 | MED | `SPEC/BUILD-FROM.md:313`, `plan.md:298` | "`/tests/` is created by Phase 4 (`L0-generators` … `L4-dualrun`)". Phase 4 is done; there is no `L0-generators`; the directory is `tests/L4-dual`. A cold reader looks for two suites that do not exist and wonders which layer holds the golden replay. |
| S2 | MED | `plan.md:290-291` | Layout lists `dual-run.sh`, `coercion-shim/`, `mutants/` under `tools/parity/` — none exist (real: `tests/L4-dual/`, `negative-controls.js` + `reports/mutation/mutants.json`). The `coercion-shim` is Part-2 work (§3 step 3) that no doc says where to put or how it is checked in. |
| S3 | MED | `plan.md:123`, `plan.md:280` | `cutover.sh` / `rollback.sh` are the cutover rule, and neither exists; no doc assigns their production to a phase, so the Part-2 engineer cannot tell whether the §10 gate is reachable. |
| S4 | MED | `tools/parity/tasks/README.md:28` vs `:43` | "IN FLIGHT (none) — both audits complete (NO-GO …)" and, 15 lines later, "Delta re-audit #2 … RUNNING". The only doc that lists gate commands cannot state whether Part 1 is closed — precisely the question a Part-2 kickoff asks. (`PARITY.md` ledger notes are the actual truth: remediation-3 closed.) |
| S5 | MED | `tools/parity/tasks/README.md:22` vs `PARITY.md:153` | Mutation ceiling stated as "648/706 killed + 58 proven" in the resume manifest vs "765/765 killed-or-proven" in the ledger. Same file `:18` says 193 fixtures / 193 pairs while `:45` says 196/196 (actual: 196). |
| S6 | LOW | `plan.md:307` | "Tag `parity-baseline` on the last legacy-only commit (`c57f438`)"; the tag is `a8f1130`. Harmless here (BASELINE.json carries the hashes), but it is the one line a cold reader uses to decide whether the oracle's source is what they think it is. |
| S7 | LOW | `plan.md:215` vs `PARITY.md:22` | Q11 location `server.js:12` vs `server.js:11`. `AGENTS.md:19` makes PARITY authoritative, so it resolves — but only because AGENTS says so. |
| S8 | LOW | `plan.md:222` vs `SPEC/BUILD-FROM.md` §8 trap 13 | Q22's required-value list: plan includes `ngl: 0`, BUILD-FROM drops it. Cosmetic for a quirk that is a requirement. |

## C. AMBIGUOUS (two readings, the doc does not say which)

| # | Sev | Location | Defect |
|---|---|---|---|
| A1 | HIGH | `plan.md:209` vs `SPEC/BUILD-FROM.md:158-162` | Q5's mechanism. Plan: `/launch-presets` uses "`DEFAULT_PORT` 8080". BUILD-FROM: that path also reads `settings.serverPort`, server-side from `settings.json`, and 8080 appears only because Q2 leaves 8080 there. For a candidate whose `settings.json` says 7838 those two readings produce different `--port` values. The recorded answer exists (`L1.PRESETS.ARGV-PORT-8080` = "--port 8080 with settings.json at 7838") but no doc points a builder at it. |
| A2 | MED | `SPEC/BUILD-FROM.md:138-139` | The argv table numbers rows 1…42 and **skips #33** (32 = `--spec-draft-n-max`, 34 = `--reasoning`). 41 fields, 41 rows, numbering to 42: nothing says #33 is a numbering artifact rather than a flag the doc forgot. |
| A3 | LOW | `SPEC/BUILD-FROM.md:88-98` (§3) | Q8 is flagged ("that list is *not* the HTML default set") but the doc never gives the list and never says where it is. The answer is machine-derivable (`SPEC/field-manifest.json` → `deleteResetRecording.changedIds` = `["loadMode"]`, `controlsCompared` 38, plus per-field `annotations.runtimeObservation.resetEvidence.resetOnDelete`), and `SPEC/CONSISTENCY.md:35-37` writes it as `field:topP.resetOnDelete`, which is not a top-level manifest path. Builder must find the nesting unaided. |
| A4 | LOW | `SPEC/BUILD-FROM.md:4-6` | "Lines carrying `not-recorded:` … the Phase 4 suites owe those a test" — but there is no register of which debts were later paid. In my L1 run `L1.SOCKET.SERVER-ERROR-UNSPAWNABLE-PATH` (the `server-error` debt at `BUILD-FROM.md:206`) is green, and the draft-block debts at `:140-143` are covered by goldens, so a builder cannot tell which of the 8+ `not-recorded:` markers still mean "unpinned". |

| A5 | MED | `SPEC/BUILD-FROM.md:16-17` | "The suites are bound to `http://localhost:7837`; anything else orphans the user's `localStorage`" conflates two different facts: the *cutover* origin (user localStorage, C3) and what a test run requires. `tests/L1-backend/run.js:87` takes `--base-url`, and L4 deliberately gives each side its own URL (7841/7842) behind a loopback forwarder so that "Part 2 gets to use the same per-side URLs against a candidate that binds its own port" (`tests/L4-dual/run.js:14-16`). Nowhere is it stated whether a candidate must bind 7837 to be *tested*, or only to be *cut over* — the difference decides whether candidate and legacy can run near-concurrently. |

## D. SILENT (I had to guess; the doc should have said)

| # | Sev | Where it should be | What is missing |
|---|---|---|---|
| D1 | HIGH | `SPEC/BUILD-FROM.md:323` (§10 step 3), `plan.md:121` | **How to point the suites at the candidate.** Plan says "via env"; the actual knobs are CLI flags discoverable only in runner sources: L1 `--attach` (+ optional `--base-url`, `tests/L1-backend/run.js:86-93`), L3 `--app <dir>` (`tests/L3-seam/run.js:58,67-69`), L4 `--ref-a/--ref-b` (`tests/L4-dual/run.js:68-69`), L2 only `--ref` — and L2's ability to take a *directory* is recorded as a disproved worker claim in `PARITY.md` (2026-11-24 entry), not in `tests/L2-ui/CHECKS.md`. BUILD-FROM §9's env list covers the **fakes**, not candidate selection. The only place the mechanism is *visible* is the Command column of `fixtures/NEGATIVES.md:24-31`, which runs `--app <dir>` (L3), `--ref <dir>` (L2) and `--ref <throwaway-ref>` (L1) — a negative-control evidence table, not a Part-2 instruction, and with no L4 example. |
| D2 | HIGH | `tests/L4-dual/` (no CHECKS.md), `SPEC/BUILD-FROM.md:323` | **L4 constrains where Part 2's code must live.** Both sides are materialised with `git archive` from a **git ref** (`tests/L4-dual/run.js:2-16`), so a Go/Rust/whatever candidate has to exist as a ref in this repo to be diffed at all. Nowhere in BUILD-FROM, plan §3, or any CHECKS.md. Also: L4 is the only layer with no `CHECKS.md`, so its inventory is undiscoverable except by running it. |
| D3 | MED | `SPEC/BUILD-FROM.md:316-324` | **The gate form.** L2 and L3 are gated at `--repeat 2` (`tools/parity/nightly/run-nightly.js:8-11`, `tests/L2-ui/CHECKS.md:15`, `tests/L3-seam/CHECKS.md:7`); BUILD-FROM §10 never says a single run is not the gate, and the pre-gates (`hash-pin --check`, `verify-manifest`) are not in §10 either. Even this audit's own command list inherited that error. |
| D4 | MED | `SPEC/BUILD-FROM.md:305-313` (§9) | **Which command runs which layer.** BUILD-FROM is the declared entry point yet names 3 commands; the per-layer command lines live only in `tests/*/CHECKS.md`, which BUILD-FROM never links, and in `tools/parity/tasks/README.md` (an internal Part-1 orchestration doc full of subagent run-ids and `C:/Users/anubh/…` watchdog paths — not a Part-2 document). |
| D5 | MED | `SPEC/BUILD-FROM.md:296-303` (§9) | **What the candidate must physically look like on disk.** L1/L3/L4 build a sandbox (fixture tree, compiled stand-in `.exe`, `settings.json` copy, nvidia-smi stub on PATH) around the app under test; for a non-Node stack, where its binary/static assets must sit and how the harness starts it is undocumented. §9 lists `PARITY_ARGV_LOG`, `NVIDIA_SMI_STUB_MODE`, `PARITY_CSC` as "the fakes already honour" without saying the candidate is expected to spawn the same stand-in. |
| D6 | MED | `SPEC/BUILD-FROM.md:1-10` | **The one-executor rule.** Nothing in BUILD-FROM (the cold-start doc) says runs are serialised by `C:/parity-scratch/.parity-lock` + ports 7837-7847, or that a concurrent run produces fake reds (AUDIT-2026-11-25 F3). A Part-2 engineer's first instinct is to run two suites in parallel. |
| D7 | LOW | `SPEC/BUILD-FROM.md:164-196` (§5) | The ini section list never states the **empty-config** case (what a section with a blank model looks like) even though the corpus round-trip can hit it; the answer is only in goldens. |
| D8 | LOW | `AGENTS.md:19` | "Every quirk row in PARITY.md (plan §9's Q1–Q22 plus Q23/Q24 and any later row the ledger gains)" — Q25 exists and is environmental (Windows `spawn EINVAL`), with a harness exemption L3-only. AGENTS' list is not wrong but a Part-2 builder reading it cannot tell that Q25 grants the candidate **no** exemption (`tools/parity/tasks/README.md:7-10`). |

## What I did NOT count as a defect

Doc-internal detail that is verbose but consistent (e.g. BUILD-FROM §4's 41-row table duplicating
`SPEC/arg-truth-table.json`), the legacy `README.md` screenshots, and `SPEC/api-contract.md`'s
deliberate "Where the recordings are silent" section — the last is genuinely useful and is how I
learned status codes were not recorded for most routes.

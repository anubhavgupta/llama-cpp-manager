# AGENTS.md — parity port operating rules

This repo is running a bug-for-bug parity port of `llama-cpp-manager`.
The legacy app at tag `parity-baseline` is the **oracle**: its output is correct by definition.
Full plan: `plan.md`. Machine state: `PARITY.md` (ledger), `ESCALATION.md` (blocked rows).

## Oracle rules (immutable)

- **C4** — Any diff between candidate and legacy output ⇒ the candidate is wrong.
  Never edit a golden or assertion to go green. Goldens may only be *re-recorded from legacy*.
- **C5** — Fixtures are recorded from legacy runs, never authored by hand.
  Every fixture file records the command that produced it.
- **C8** — Gates are immutable: `fixtures/`, `tests/`, thresholds, `PARITY.md` status column,
  and this file are hash-pinned in `fixtures/HASH-PIN.json`. A hash change without a
  backing ledger entry fails the Auditor.

## DO-NOT-FIX list

Every quirk row in `PARITY.md` (plan §9's Q1–Q22 plus Q23/Q24 and any later row the ledger gains) is a **requirement**, not a defect. PARITY.md is the authoritative quirk list; this file's examples never bound it.
This includes: the /settings TDZ bug (Q2), 200-with-success:false on /start (Q3),
simulated GPU metrics (Q6), partial delete reset (Q8), trailing `port = ` in ini (Q10),
orphan keys dropped on re-save (Q16), silently-blanking retired enum values (Q18).
No behavior changes, no bug fixes, no improvements, no scope changes.

## Tie-break ladder (never ask a human)

1. Recorded runtime evidence from legacy at `parity-baseline` — always wins.
2. Static code read of legacy.
3. Independent model derivation.
4. Re-run capture with a targeted probe isolating the case. Probing legacy IS the resolution.

Still unresolved ⇒ ledger row becomes `blocked` with a machine-written `ESCALATION.md`
entry. Never a question. Never `pass`.

## Role boundaries (no self-certification)

| Role | Owns | May not |
|---|---|---|
| Builder | candidate source | edit `/fixtures`, `/tests`, thresholds, `PARITY.md` status, `AGENTS.md` |
| Verifier | harness, fixtures, ledger | write candidate feature code; hand-edit goldens (may only re-record from legacy) |
| Auditor | final go/no-go, fresh context | — |

## Suite design rules

- Base URL, socket URL, binary path, model dir, nvidia-smi mode all from env.
  Suites never import app code. The identical suites run against legacy and candidate.
- Comparison mode per field is declared in `fixtures/COMPARISON.json` (`exact` default,
  `shape` for §8 nondeterminism rows). Adding a `shape` field requires a ledger entry.
- Flake protocol: N-repeat ⇒ `quarantine` with captured traces ⇒ fixed like any red.
  Never skipped, never deleted.
- Blast radius: work only on the `migration` branch; never touch the real
  `settings.json` / `models-preset.ini` / model dirs — fixture copies only.

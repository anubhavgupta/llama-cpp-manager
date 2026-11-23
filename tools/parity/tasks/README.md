# Resume manifest — Part 1 orchestration state

If the supervising session restarts, resume from here. Durable state = git commits +
`PARITY.md` (ledger) + `fixtures/HASH-PIN.json` + `fixtures/MANIFEST.json` + `tools/parity/reports/`.
Task specs in this directory are the exact prompts each worker phase ran on.

## Done (verify by re-running the gate commands, not by trusting this file)

| Phase | Commit | Gate command(s) |
|---|---|---|
| 0 freeze | 92c52a2 | `bash tools/parity/freeze-baseline.sh` (must reproduce BASELINE.json content), `bash tools/parity/hash-pin.sh` diff-clean |
| 1a fakes/tree/corpus | 022dd13 | `node tools/parity/selftest-fake.js` (19), `bash tools/parity/selftest-tree.sh` (44), `node tools/parity/selftest-corpus.js` (861) |
| 1b capture + re-records | 833afd1, 6a9994e | `bash tools/parity/capture-legacy.sh --verify-determinism` (~5 min, 193 fixtures), `node tools/parity/verify-manifest.js` (193/193), `node tools/parity/leak-check.js fixtures SPEC` CLEAN |
| 2 inventory | 3998c78 | `node tools/parity/ast-inventory.js --check && node tools/parity/ast-inventory.js --selftest` |
| 2.1 extraction proof | 4578af9..4e67e90 | `node tools/parity/preservation-proof.js --differential`; full `preservation-proof.sh` |
| 2.3–2.5 vectors/goldens | 9d6a767 (+promotions 657bce5) | `node tools/parity/gen-vectors.js --check`, `gen-goldens.js --check`, `equivalence.js`, `equivalence.js --verify`, `equivalence.js --selftest` (<60 s) |
| 2.6 mutation ceiling | 657bce5 | see `tools/parity/reports/mutation/REPORT.md` gates (mutate/mutation-run/equiv-prove --selftest + 7 report gates); 648/706 killed + 58 proven, 0 gaps |
| 3 SPEC pack | 9e34878 (+re-derive 6a9994e) | `node tools/parity/spec-reconcile.js` → unreconciled=0; `SPEC/CONSISTENCY.md` |
| 4 L1 backend suite | 34644b1 | `node tests/L1-backend/run.js --verify-against-selftest` (~100 s) green ×3; 63 checks |

## IN FLIGHT

- **L2 UI suite + corpus round-trip** (`task-l2.md`): mid-work snapshot committed inside 34644b1 (15 files +
  fixtures/goldens/resave inputs; HASH-PIN gained pins — verified additions-only). Remaining per its spec:
  corpus round-trip green vs recorded-from-legacy expectations, DISAGREEMENTS.md, ini-order 2-config subset,
  2× `--verify-selftest`. Landing commit MUST include: final hash-pin refresh + PARITY ledger row for the
  resave family (C8 event). It was steered about the snapshot.

## Next after L2 (specs ready)
- **L2 UI suite + corpus round-trip** (`task-l2.md`): 7 check modules exist; recording `fixtures/goldens/resave/`
  from parity-baseline page. Supervisor decisions in force: recorded-from-legacy corpus expectations (NOT raw
  goldens/corpus equality; emit DISAGREEMENTS.md classifying divergences to Q17/Q18/Q19); mechanical /models
  fill for corpus launch mode + recorded-J2-payload mode asserted separately; ini-order assertion from all-48
  AND one 2-config subset; gen-goldens resave family extension → MANIFEST 17 entries → **Verifier re-pins
  HASH-PIN.json + ledger row in the SAME landing commit** (worker must not touch HASH-PIN/PARITY).

## Next after L1/L2 (specs ready)

1. `task-l3l4.md` — L3 seam suite (real server+browser+fake), L4 dual-run scaffold with self-mode (A=B=tag ⇒
   empty diff), nightly job (schtasks, 03:00), negative controls (mutant patches ⇒ named reds ⇒ fixtures/NEGATIVES.md).
2. Part-1 exit checklist (plan §2): L1–L4 100% green vs legacy; NEGATIVES.md complete; mutation at ceiling
   (done); SPEC-ROWS fully mapped (done); all PARITY rows → baseline-verified (needs L-suite evidence per row);
   corpus round-trip green (L2/L3); nightly installed + green.
3. Auditor pack: fresh-context go/no-go per plan §5.

## Supervisor notes (durable lessons)

- Provider hangs (UND_ERR_BODY_TIMEOUT / silent 300s+ freezes) hit several times/day: recovery =
  interrupt → (pause notice) → resume with "continue from disk state, do not redo green work". All workers
  carry checkpoint/resume + medium-turn instructions.
- Ownership discipline: fixtures/SPEC/PARITY/HASH-PIN/capture-legacy are Verifier-owned; workers get explicit
  additive exceptions in writing (see PARITY.md ledger notes for each C8-sanctioned change).
- Windows facts baked into tooling: no SIGTERM delivery to node children (TerminateProcess), .cmd unspawnable
  without shell (CVE-2024-27980), stand-in = csc-compiled relay exe with KILL_ON_JOB_CLOSE job object;
  scratch root default `C:/parity-scratch`.

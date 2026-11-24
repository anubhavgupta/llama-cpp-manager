// Watchdog: revive stalled parity-port workers. See tools/parity/tasks/README.md (Watchdog procedure).
const report = await runs.run("main", {
  agent: "worker",
  task:
    "You are the parity-port watchdog. Repo C:/projects/Cline-demo. Read tools/parity/tasks/README.md section '## Watchdog procedure' and tools/parity/tasks/WATCHDOG.json, then execute the procedure exactly for every tracked run id. If control actions are denied by policy, do not force anything: record that in tools/parity/reports/watchdog.log and stop. Never interrupt runs listed in ignoreIds. Medium-sized tool calls; you must finish within ~5 minutes.",
});
const summary = (report && report.output ? String(report.output) : "").slice(0, 1500);
return { ok: !!report.ok, ranAt: new Date().toISOString(), summary };

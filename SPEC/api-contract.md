# API contract — human view

`SPEC/api-contract.openapi.json` is the machine form (OpenAPI 3.0.3, structure-checked by the
reconciler). This view lists the same routes with their evidence pointers.

Base URL: `http://localhost:7837` — the origin every recorded request was issued against (Q11: settings.serverPort never changes it)

| route | statuses | status source | request body fields | evidence |
|---|---|---|---|---|
| `GET /` | 200 | static source read | — | http/J0-baseline/root.request.json |
| `GET /metrics` | 200 | static source read | — | http/J1-settings/metrics-1.request.json, http/J1-settings/metrics-2.request.json |
| `GET /models` | 200, 500 | static source read | — | http/J2-models/models.request.json |
| `GET /restart` | 200 | static source read | — | http/J3d-restart/restart-get-not-a-route.request.json |
| `POST /restart` | 200, 400, 500 | static source read + runtime recording | — | http/J3d-restart/restart-after-manager-restart.request.json, http/J3d-restart/restart-before-any-launch.request.json |
| `GET /settings` | 200 | static source read | — | http/J0-baseline/settings-first-run.request.json, http/J1-settings/settings-read.request.json |
| `POST /settings` | 200, 400, 500 | static source read | modelsDirectory, serverPort | http/J1-settings/settings-post-with-port.request.json, http/J1-settings/settings-post-without-port.request.json |
| `GET /status` | 200 | static source read | — | http/J1-settings/status.request.json, http/J3-start-stop/status-before.request.json |
| `GET /swagger` | 200 | static source read | — | http/J0-baseline/swagger.request.json |
| `GET /swagger.json` | 200 | static source read | — | http/J0-baseline/swagger-json.request.json |
| `POST /launch-presets` | 200, 400, 500 | static source read | presets, serverPath, serverPort | http/J4-launch-presets/launch-presets-default-port.request.json, http/J4-launch-presets/launch-presets-explicit-port.request.json |
| `POST /start` | 200, 400, 500 | runtime recording + static source read | args, serverPath | http/J3-start-stop/start-while-running.request.json, http/J3-start-stop/start.request.json |
| `POST /stop` | 200, 500 | static source read | — | http/J3-start-stop/stop.request.json, http/J3c-start-missing-path/stop-while-idle.request.json |

## Server facts

- listen port: 7837 (a+c+b) — `settings.serverPort` never changes it (Q11)
- default port constant: 8080
- middleware in registration order: express.static('public') + express.json() + express.urlencoded({ extended: true })
- not app routes: {"evidence":["public/script.js:17","public/script.js:18","public/script.js:19"],"path":"/swagger.json","why":"no app.get registration exists; express.static(public) serves the checked-in file"}, {"evidence":["server.js:425"],"path":"GET /restart","why":"only app.post('/restart') is registered, so express answers the default 404 page"}

## Runtime-only observations

- restart settle: POST /restart answers 200 success:true, but /status settles on running:false: the killed child's close handler clears runningProcess after /restart as
- metrics degradation: With nvidia-smi replying "not a csv", getSystemMetrics() parses the line, finds fewer than 3 comma fields, and returns WITHOUT throwing — so the Math.
- client polling: {"/metrics":12,"/status":2} per 12018 ms window
- launch-presets port source: 7838

## Where the recordings are silent

- HTTP status codes are missing from every recording except the ones listed in routes[].statusesRecorded; the response bodies are recorded in full
- response headers were not captured, so content types are not derivable from the recordings
- server-side branch coverage: a body recorded for one input says nothing about the branch another input would take

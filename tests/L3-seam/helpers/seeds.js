'use strict';
// The seeds both the seam suite and the dual-run driver use, in one place. They are INPUTS; every
// expectation in either suite stays a recorded artifact.

const { winPath } = require('./pathmap');

const harness = require('../../L1-backend/lib/harness');
const l2fixtures = require('../../L2-ui/helpers/fixtures');

// The recorded two-config storage state (fixtures/localstorage/J5-ui-states/after-save-config.json)
// with the settings port the recorded J5 journey used — its argv carries `--port 7838` — and
// modelsDirectory aimed at this sandbox's fixture tree, the value the recorded J1/J4 journeys POSTed.
function uiSeed(manager) {
    const capture = harness.fixtureJson('localstorage/J5-ui-states/after-save-config.json');
    const entries = capture.storage ? capture.storage.entries : capture.entries;
    const find = (key) => (entries.find((entry) => entry[0] === key) || [])[1] || null;
    // The recorded entry carries the recording machine's scratch paths; a run in a different root
    // (L4 gives each side its own) has to re-point them, or every modelPath misses its <option> and
    // blanks (Q18). With the default root this is a no-op.
    return {
        configsKey: 'llamaCppConfigs',
        configsJson: manager.pathMap().portable(find('llamaCppConfigs')),
        settingsKey: 'llamaCppSettings',
        settingsJson: JSON.stringify({ serverPort: 7838, modelsDirectory: winPath(manager.modelsDir) })
    };
}

// Corpus localStorage in both forms: resolved into this sandbox's scratch paths (§9A remapped mode
// applies the PATH-MAP mapping to the inputs and to the expected bytes), and verbatim in tokens.
function corpusSeeds(manager) {
    const corpus = l2fixtures.corpusSeed();
    const map = manager.pathMap();
    const resolvedSettings = map.walk(corpus.settings);
    return {
        corpus,
        resolved: {
            configsKey: 'llamaCppConfigs',
            configsJson: JSON.stringify(map.walk(corpus.configs)),
            settingsKey: 'llamaCppSettings',
            settingsJson: JSON.stringify(resolvedSettings)
        },
        tokens: {
            configsKey: 'llamaCppConfigs',
            configsJson: corpus.configsJson,
            settingsKey: 'llamaCppSettings',
            settingsJson: corpus.settingsJson
        },
        settingsPort: resolvedSettings.serverPort
    };
}

module.exports = { uiSeed, corpusSeeds };

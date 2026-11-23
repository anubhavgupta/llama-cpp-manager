'use strict';
// Comparison of a freshly captured page fingerprint against fixtures/screenshots/**.render.json.
//
// fixtures/COMPARISON.json rule "screenshot-pixels" makes the PNG informational and names the
// paired .render.json as the claim, and the default mode is "exact": geometry, visibility and
// control state of every [id] element, digits masked (the recording masks them, because percent
// readouts are sampler output), canvases display:none, animations off, page clock frozen. Nothing
// here relaxes that. The one field that is not compared at byte level is
// logPane.startsWithTimestamp in the CAPPED state, where the recording itself writes
// '<chunk-boundary>': PARITY.md (quarantine 2026-11-23, resolved 2026-11-23) records that which
// stream fragment the 1000-entry boundary leaves at the pane head is plan §8 "websocket log chunk
// boundaries". The mask lives in the producer (both here and in the recorder), so a state below the
// cap still compares the real boolean, and lineCount / anyEntryTimestamped stay compared everywhere.

function elementById(elements) {
    return new Map(elements.map((element) => [element.id, element]));
}

const COMPARED_ELEMENT_KEYS = ['tag', 'visible', 'rect', 'text'];
const OPTIONAL_ELEMENT_KEYS = ['value', 'checked', 'disabled'];

function compareElements(recorded, captured) {
    const problems = [];
    const mine = elementById(captured);
    const theirs = elementById(recorded);
    const missing = [...theirs.keys()].filter((id) => !mine.has(id));
    const extra = [...mine.keys()].filter((id) => !theirs.has(id));
    if (missing.length) problems.push('elements present in the recording but not rendered: ' + missing.join(', '));
    if (extra.length) problems.push('elements rendered but not in the recording: ' + extra.join(', '));
    for (const [id, want] of theirs) {
        const have = mine.get(id);
        if (!have) continue;
        for (const key of COMPARED_ELEMENT_KEYS) {
            if (JSON.stringify(want[key]) !== JSON.stringify(have[key])) {
                problems.push(id + '.' + key + ': recorded ' + JSON.stringify(want[key])
                    + ' rendered ' + JSON.stringify(have[key]));
            }
        }
        for (const key of OPTIONAL_ELEMENT_KEYS) {
            if (!(key in want)) continue;
            if (JSON.stringify(want[key]) !== JSON.stringify(have[key])) {
                problems.push(id + '.' + key + ': recorded ' + JSON.stringify(want[key])
                    + ' rendered ' + JSON.stringify(have[key]));
            }
        }
    }
    return problems;
}

function compareRender(recorded, captured) {
    const problems = [];
    if (JSON.stringify(recorded.viewport) !== JSON.stringify(captured.viewport)) {
        problems.push('viewport: recorded ' + JSON.stringify(recorded.viewport)
            + ' rendered ' + JSON.stringify(captured.viewport));
    }
    if (recorded.title !== captured.title) {
        problems.push('title: recorded ' + JSON.stringify(recorded.title)
            + ' rendered ' + JSON.stringify(captured.title));
    }
    if (recorded.scrollHeight !== captured.scrollHeight) {
        problems.push('scrollHeight: recorded ' + recorded.scrollHeight + ' rendered ' + captured.scrollHeight);
    }
    if (recorded.logPane.lineCount !== captured.logPane.lineCount) {
        problems.push('logPane.lineCount: recorded ' + recorded.logPane.lineCount
            + ' rendered ' + captured.logPane.lineCount);
    }
    if (recorded.logPane.anyEntryTimestamped !== captured.logPane.anyEntryTimestamped) {
        problems.push('logPane.anyEntryTimestamped: recorded ' + recorded.logPane.anyEntryTimestamped
            + ' rendered ' + captured.logPane.anyEntryTimestamped);
    }
    // The masked field: equal when both sides are below the cap (real booleans), and equal to the
    // mask token when the recording was taken at the cap. See the header note (PARITY.md ledger).
    const recordedCapped = recorded.logPane.startsWithTimestamp === '<chunk-boundary>';
    const capturedCapped = captured.logPane.startsWithTimestamp === '<chunk-boundary>';
    if (recordedCapped !== capturedCapped) {
        problems.push('logPane at-cap state differs: recorded lineCount ' + recorded.logPane.lineCount
            + ' rendered lineCount ' + captured.logPane.lineCount);
    } else if (!recordedCapped
        && recorded.logPane.startsWithTimestamp !== captured.logPane.startsWithTimestamp) {
        problems.push('logPane.startsWithTimestamp: recorded ' + recorded.logPane.startsWithTimestamp
            + ' rendered ' + captured.logPane.startsWithTimestamp);
    }
    problems.push(...compareElements(recorded.elements, captured.elements));
    return problems;
}

module.exports = { compareRender, compareElements, COMPARED_ELEMENT_KEYS };

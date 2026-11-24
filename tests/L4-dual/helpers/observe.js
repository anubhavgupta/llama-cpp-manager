'use strict';
// The observation model the dual-run compares: a flat set of named fields, each tagged with the
// fixture family its value belongs to (or null when no fixture covers it, which means the
// COMPARISON default of byte equality), and the field-level differ.
//
// Two normalisations, deliberately separate:
//   - collection time: machine-bound tokens (scratch root, app dir, stand-in exe, node path) are
//     rewritten to PATH-MAP tokens by the probe that owns the value, so two runs in two scratch
//     roots speak the same language;
//   - diff time: fixtures/COMPARISON.json's declared shape ops (§8 nondeterminism), applied to both
//     sides, plus that rule's `assert` clauses re-checked on both sides. A rule can only relax what
//     §8 declares nondeterministic, so the differ cannot quietly become a shrug.

const fs = require('fs');
const path = require('path');

const { normalise } = require('../../L3-seam/helpers/compare');
const harness = require('../../L1-backend/lib/harness');

class Observation {
    constructor(side, target) {
        this.side = side;
        this.target = target;
        this.fields = new Map();
        this.problems = [];
    }

    // `family` is a fixtures/-relative path (e.g. 'argv/J3-start-stop/launch.jsonl'), used only to
    // look up the comparison rule; the value itself is this run's live bytes, tokenised.
    add(key, family, value) {
        if (this.fields.has(key)) {
            throw new Error('observation field ' + key + ' was recorded twice by side ' + this.side);
        }
        this.fields.set(key, { key, family, value });
        return this;
    }

    problem(text) {
        this.problems.push(text);
        return this;
    }

    toJSON() {
        return { side: this.side, target: this.target, problems: this.problems,
            fields: [...this.fields.values()] };
    }

    write(file) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(this.toJSON(), null, 2));
        return file;
    }

    static read(file) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const observation = new Observation(raw.side, raw.target);
        for (const field of raw.fields) observation.add(field.key, field.family, field.value);
        observation.problems = raw.problems || [];
        return observation;
    }
}

const printable = (value) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > 400 ? text.slice(0, 400) + '…' : text;
};

// Compare two observations field by field. Returns one row per field that differs, plus the policy
// violations (a side that no longer satisfies the shape rule that is allowed to relax it).
function diff(a, b) {
    const rows = [];
    const violations = [];
    const keys = [...new Set([...a.fields.keys(), ...b.fields.keys()])];
    for (const key of keys) {
        const left = a.fields.get(key);
        const right = b.fields.get(key);
        if (!left || !right) {
            rows.push({ key, family: (left || right).family, side_missing: left ? 'B' : 'A',
                a: left ? printable(left.value) : '<not recorded>',
                b: right ? printable(right.value) : '<not recorded>' });
            continue;
        }
        const family = left.family;
        if (family !== right.family) {
            violations.push(key + ': the two sides tagged this field with different fixture families ('
                + left.family + ' vs ' + right.family + ')');
        }
        const rule = family ? harness.ruleFor(family) : null;
        const mode = rule ? rule.id + ':' + rule.mode : 'exact';
        let leftText, rightText;
        try {
            leftText = family ? normalise(family, serialize(left.value)) : serialize(left.value);
            rightText = family ? normalise(family, serialize(right.value)) : serialize(right.value);
        } catch (error) {
            violations.push(key + ': the comparison policy could not be applied — ' + error.message);
            continue;
        }
        if (rule && rule.assert) {
            for (const spec of rule.assert) {
                const implement = harness.ASSERT[spec.op];
                if (!implement) continue;
                for (const [side, raw] of [['A', serialize(left.value)], ['B', serialize(right.value)]]) {
                    violations.push(...implement(raw, spec).map((text) => key + ' [' + side + '] ' + text));
                }
            }
        }
        if (leftText !== rightText) {
            rows.push({ key, family, mode,
                a: printable(left.value), b: printable(right.value),
                firstDifference: firstDifference(leftText, rightText) });
        }
    }
    return { rows, violations };
}

function serialize(value) {
    return typeof value === 'string' ? value : JSON.stringify(value);
}

function firstDifference(a, b) {
    const limit = Math.min(a.length, b.length);
    let index = 0;
    while (index < limit && a[index] === b[index]) index += 1;
    return index;
}

module.exports = { Observation, diff, printable };

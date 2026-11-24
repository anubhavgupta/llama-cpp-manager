'use strict';
// Machine-bound tokens, applied at collection time on both sides of a dual run: the scratch root,
// the app dir, the fixture tree, the compiled stand-in and the node executable the stand-in relays
// to. Everything else stays literal, so a value that differs in behaviour still differs here.

const { recordedNodeExe } = require('../../L3-seam/helpers/compare');

const NODE = recordedNodeExe();

function tokenise(manager, value) {
    const map = manager.pathMap();
    const walk = (node) => {
        if (typeof node === 'string') {
            const text = map.tokenize(node);
            return NODE ? text.split(NODE.replace(/[\\/]+/g, '\\')).join('<NODE>') : text;
        }
        if (Array.isArray(node)) return node.map(walk);
        if (node && typeof node === 'object') {
            return Object.fromEntries(Object.keys(node).map((key) => [key, walk(node[key])]));
        }
        return node;
    };
    return walk(value);
}

module.exports = { tokenise };

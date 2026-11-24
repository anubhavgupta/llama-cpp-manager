'use strict';
// The read-only page probes from the L2 suite (tests/L2-ui/helpers/browser.js), required unchanged.
// They are pure DOM/storage readers, so the seam layer uses the same fingerprints the L2 layer
// asserts, against a live backend instead of a mocked one.

module.exports = require('../../L2-ui/helpers/browser');

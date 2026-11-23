// Phase 2.1 (plan.md §2): the argv generator of public/script.js launchServer, extracted verbatim.
//
// Mechanical extraction, not a rewrite. Every coercion expression, comparison and push order below
// is the inline original's text with one substitution: `element.value` / `element.checked` became
// `fields.<element id>`. Coercions (.trim(), parseInt, parseFloat, `|| 0`, the `!= "0"` /
// `== "0.00"` string compares) stay here, in the original order, unchanged (C1).
//
// fields is keyed by element id and is built by the caller by reading each element ONCE, in the
// order listed here (the order of the original `const config = {...}` literal):
//   modelPath, ngl, threads, temp, topK, topP, minP, repeatPenalty, presencePenalty, parallel,
//   loadMode, swaFull, backendSampling, contextSize, nCpuMoe, cpuMoe, noKvOffload, noMmprojOffload,
//   cacheRam, speculationType, ngramMod, specDraftNMax, ctkEnable, contextTokenKey,
//   contextTokenValue, fastAttention, jinja, verbose, reasoning, loadCustomChatTemplate,
//   chatTemplateKwargs, draftModelPath, ngld, ctkd, ctvd
// The value stored per id is exactly the property the original expression read: `.value` for the
// inputs/selects (including `fastAttention`, a <select> the original reads via `.value` — Q9) and
// `.checked` for the checkboxes.
//
// models is the caller's `window.models` (the last /models payload); the trailing --mmproj pass
// reads it in the original position, after --host/-fit/--port.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    const global = root || {};
    const lib = global.ParityLib = global.ParityLib || {};
    for (const key of Object.keys(api)) lib[key] = api[key];
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function buildArgs(fields, settings, models) {
        const config = {
            modelPath: fields.modelPath.trim(),
            ngl: parseInt(fields.ngl) || 0,
            threads: parseInt(fields.threads) || 1,
            temp: parseFloat(fields.temp) || 0,
            topK: parseInt(fields.topK) || 0,
            topP: parseFloat(fields.topP) || 0,
            minP: fields.minP || 0,
            repeatPenalty: fields.repeatPenalty || 0,
            presencePenalty: fields.presencePenalty || 0,
            parallel: parseInt(fields.parallel) || 0,
            loadMode: fields.loadMode,
            swaFull: fields.swaFull,
            backendSampling: fields.backendSampling,
            contextSize: parseInt(fields.contextSize) || 1,
            nCpuMoe: parseInt(fields.nCpuMoe) || 0,
            cpuMoe: fields.cpuMoe,
            noKvOffload: fields.noKvOffload,
            noMmprojOffload: fields.noMmprojOffload,
            cacheRam: parseInt(fields.cacheRam),
            speculationType: fields.speculationType,
            ngramMod: fields.ngramMod,
            specDraftNMax: parseInt(fields.specDraftNMax) || 0,
            ctkEnable: fields.ctkEnable,
            contextTokenKey: fields.contextTokenKey,
            contextTokenValue: fields.contextTokenValue,
            fastAttention: fields.fastAttention,
            jinja: fields.jinja,
            verbose: fields.verbose,
            reasoning: fields.reasoning,
            loadCustomChatTemplate: fields.loadCustomChatTemplate,
            chatTemplateKwargs: fields.chatTemplateKwargs.trim(),
            draftModelPath: fields.draftModelPath.trim(),
            ngld: parseInt(fields.ngld) || 0,
            ctkd: fields.ctkd,
            ctvd: fields.ctvd
        };

        // Build command arguments
        const args = [];

        if (config.modelPath) {
            args.push('-m', config.modelPath);
        }

        if (config.ngl > 0) {
            args.push('-ngl', config.ngl.toString());
        }

        if (config.threads > 0) {
            args.push('-t', config.threads.toString());
        }

        if (config.temp >= 0) {
            args.push('--temp', config.temp.toString());
        }

        if (config.topK > 0) {
            args.push('--top-k', config.topK.toString());
        }

        if (config.topP >= 0) {
            args.push('--top-p', config.topP.toString());
        }

        if ((!isNaN(parseFloat(config.minP)) && config.minP != "0") || config.minP == "0.00") {
            args.push('--min-p', config.minP.toString());
        }

        if ((!isNaN(parseFloat(config.repeatPenalty)) && config.repeatPenalty != "0") || config.repeatPenalty == "0.00") {
            args.push('--repeat-penalty', config.repeatPenalty.toString());
        }

        if ((!isNaN(parseFloat(config.presencePenalty)) && config.presencePenalty != "0") || config.presencePenalty == "0.00") {
            args.push('--presence-penalty', config.presencePenalty.toString());
        }

        // Add parallel parameter
        if (config.parallel > 0) {
            args.push('--parallel', config.parallel.toString());
        }

        if (config.loadMode) {
            args.push('--load-mode', config.loadMode);
        }

        if (config.swaFull) {
            args.push('--swa-full');
        }

        if (config.contextSize > 0) {
            args.push('-c', config.contextSize.toString());
        }

        if (config.nCpuMoe > 0) {
            args.push('--n-cpu-moe', config.nCpuMoe.toString());
        }

        if (config.cpuMoe) {
            args.push('--cpu-moe');
        }

        // Add context token parameters if enabled
        if (config.ctkEnable && config.contextTokenKey && config.contextTokenValue) {
            args.push('-ctk', config.contextTokenKey);
            args.push('-ctv', config.contextTokenValue);
        }

        // Add fast attention flag with proper value
        if (config.fastAttention && config.fastAttention !== 'auto') {
            args.push('-fa', config.fastAttention);
        } else if (config.fastAttention === 'auto') {
            // For 'auto' we still add -fa but without a value to maintain compatibility
            // Or we can just skip it since 'auto' is default behavior
            args.push('-fa');
        }

        // Add jinja flag if checked
        if (config.jinja) {
            args.push('--jinja');
        }

        // Add chat-template-kwargs if provided
        if (config.chatTemplateKwargs) {
            args.push('--chat-template-kwargs', config.chatTemplateKwargs);
        }

         // Add --chat-template-file if custom chat template is enabled
        if (config.loadCustomChatTemplate && config.modelPath) {
            // Derive the model directory from the model path and append chat-template.jinja
            const modelDir = config.modelPath.replace(/[/\\][^/\\]*$/, '');
            args.push('--chat-template-file', modelDir + '\\chat-template.jinja');
        }

        // Add verbose flag if checked
        if (config.verbose) {
            args.push('--verbose');
        }

        // Add backend-sampling flag if checked
        if (config.backendSampling) {
            args.push('--backend-sampling');
        }

        // Add no-kv-offload flag if checked
        if (config.noKvOffload) {
            args.push('--no-kv-offload');
        }

        // Add no-mmproj-offload flag if checked
        if (config.noMmprojOffload) {
            args.push('--no-mmproj-offload');
        }

        // Add cache RAM limit (--cache-ram): -1 = no limit, 0 = disable
        if (config.cacheRam !== undefined && !Number.isNaN(config.cacheRam)) {
            args.push('--cache-ram', String(config.cacheRam));
        }

        // Add speculation flags
        if (config.speculationType !== 'none' || config.ngramMod) {
            const specTypes = [];
            if (config.ngramMod) specTypes.push('ngram-mod');
            if (config.speculationType !== 'none') specTypes.push(config.speculationType);
            if (specTypes.length > 0) {
                args.push('--spec-type', specTypes.join(','));
            }
            // ngram-mod specific flags (always added when ngramMod is checked)
            if (config.ngramMod) {
                args.push('--spec-ngram-mod-n-match', '24');
                args.push('--spec-ngram-mod-n-min', '48');
                args.push('--spec-ngram-mod-n-max', '64');
            }
            // draft n-max (applies to draft-mtp, draft-dflash, draft-dspark only)
            if (config.specDraftNMax > 0 && config.speculationType !== 'none') {
                args.push('--spec-draft-n-max', config.specDraftNMax.toString());
            }
        }

        // Add reasoning flag
        if (config.reasoning === 'off') {
            args.push('--reasoning', 'off');
        } else if (config.reasoning === 'on') {
            args.push('--reasoning', 'on');
        }

        // Add draft model parameters if specified
        if (config.draftModelPath && config.speculationType !== 'none' && config.speculationType !== 'draft-mtp') {
            args.push('-md', config.draftModelPath);
            if (config.ngld >= 0) {
                args.push('-ngld', config.ngld.toString());
            }
            if (config.ctkd) {
                args.push('-ctkd', config.ctkd);
            }
            if (config.ctvd) {
                args.push('-ctvd', config.ctvd);
            }
        }

        args.push("--host", "0.0.0.0");
        args.push("-fit", "off");
        args.push("--port", settings.serverPort.toString());

        // mmproj loading
        const modelPath = fields.modelPath.trim();
        models.forEach(model => {
            if (model.path === modelPath && model.mmprojFile) {
                args.push('--mmproj', model.mmprojFile);
            }
        });

        return args;
    }

    return { buildArgs: buildArgs };
});

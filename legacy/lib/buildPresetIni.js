// Phase 2.1 (plan.md §2): the models-preset.ini generator of public/script.js launchModelPresets,
// extracted verbatim.
//
// Mechanical extraction, not a rewrite: the body is the inline original's text with one
// substitution, `window.models` -> the `models` parameter (the caller passes its `window.models`).
// `Object.entries(configs)` insertion order is the section order (plan §9 trap 6), the ini keys
// `spec-ngram-size-n` / `draft-min` / `draft-max` and the legacy-`disableReasoning` fallback are
// kept as written (Q10, Q17), and no coercion or comment is cleaned up (C1).
//
// The trailing `port = ${settings.serverPort}\n` line is NOT part of this return value: in
// launchModelPresets it is appended after `showOutput(presetContent)`, so the pane shows the
// sections without it and the POST body carries it. Moving it inside the generator would change
// what the pane prints, so that one line stays inline in script.js, unchanged.
(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    const global = root || {};
    const lib = global.ParityLib = global.ParityLib || {};
    for (const key of Object.keys(api)) lib[key] = api[key];
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    function buildPresetIni(configs, models) {
        let presetContent = 'version = 1\n\n';

        // Process each configuration
        for (const [configName, config] of Object.entries(configs)) {
            // Create a section name based on the model path or configuration name
            let sectionName = configName;
            // if (config.modelPath) {
            //     // Extract just the filename for the section name if it's a GGUF model path
            //     const fileName = config.modelPath.split('/').pop().split('\\').pop();
            //     if (fileName && fileName.endsWith('.gguf')) {
            //         sectionName = fileName.replace('.gguf', '');
            //     }
            // }

            // Create section header with proper format
            presetContent += `[${sectionName}]\n`;

            // Add model path if available
            if (config.modelPath) {
                presetContent += `model = ${config.modelPath}\n`;
            }
            // mmproj loading
            const modelPath = config.modelPath;
            models.forEach(model => {
                if (model.path === modelPath && model.mmprojFile) {
                    presetContent += `mmproj = ${model.mmprojFile}\n`;
                }
            });

            // Add other parameters based on the configuration
            if (config.temp !== undefined && config.temp >= 0) {
                presetContent += `temp = ${config.temp}\n`;
            }

            if (config.contextSize > 0) {
                presetContent += `c = ${config.contextSize.toString()}\n`;
            }

            if (config.topK !== undefined && config.topK > 0) {
                presetContent += `top-k = ${config.topK}\n`;
            }

            if (config.topP !== undefined && config.topP >= 0) {
                presetContent += `top-p = ${config.topP}\n`;
            }

            if ((!isNaN(parseFloat(config.minP)) && config.minP != "0") || config.minP == "0.00") {
                presetContent += `min-p = ${config.minP}\n`;
            }

            if ((!isNaN(parseFloat(config.repeatPenalty)) && config.repeatPenalty != "0") || config.repeatPenalty == "0.00") {
                presetContent += `repeat-penalty = ${config.repeatPenalty}\n`;
            }

            if ((!isNaN(parseFloat(config.presencePenalty)) && config.presencePenalty != "0") || config.presencePenalty == "0.00") {
                presetContent += `presence-penalty = ${config.presencePenalty}\n`;
            }

            if (config.ngl !== undefined && config.ngl > 0) {
                presetContent += `ngl = ${config.ngl}\n`;
            }

            if (config.threads !== undefined && config.threads > 0) {
                presetContent += `threads = ${config.threads}\n`;
            }

            if (config.nCpuMoe !== undefined && config.nCpuMoe > 0) {
                presetContent += `n-cpu-moe = ${config.nCpuMoe}\n`;
            }

            if (config.cpuMoe) {
                presetContent += 'cpu-moe = true\n';
            }

            // Add parallel parameter
            if (config.parallel > 0) {
                   presetContent += `parallel = ${config.parallel}\n`;
            }


            if (config.loadMode !== undefined) {
                presetContent += `load-mode = ${config.loadMode}\n`;
            }

            if (config.noKvOffload !== undefined && config.noKvOffload) {
                presetContent += `no-kv-offload = true\n`;
            }

            if (config.noMmprojOffload !== undefined && config.noMmprojOffload) {
                presetContent += `no-mmproj-offload = true\n`;
            }

            if (config.cacheRam !== undefined && !Number.isNaN(config.cacheRam)) {
                presetContent += `cache-ram = ${config.cacheRam}\n`;
            }

            if (config.jinja !== undefined && config.jinja) {
                presetContent += `jinja = true\n`;
            }

            if (config.chatTemplateKwargs) {
                presetContent += `chat-template-kwargs = ${config.chatTemplateKwargs}\n`;
            }

            if (config.loadCustomChatTemplate !== undefined && config.loadCustomChatTemplate) {
                presetContent += `chat-template-file = ${config.modelPath.replace(/[/\\][^/\\]*$/, '')}\\chat-template.jinja\n`;
            }

            if (config.verbose !== undefined && config.verbose) {
                presetContent += `verbose = true\n`;
            }

            if (config.backendSampling !== undefined && config.backendSampling) {
                presetContent += `backend-sampling = true\n`;
            }

            if (config.fastAttention) {
                presetContent += `fa = ${config.fastAttention ?? 'auto'}\n`;
            }

            // Add draft model parameters if available
            if (config.draftModelPath && config.speculationType !== 'none' && config.speculationType !== 'draft-mtp') {
                presetContent += `model-draft = ${config.draftModelPath}\n`;
                if (config.ngld !== undefined && config.ngld >= 0) {
                    presetContent += `ngld = ${config.ngld}\n`;
                }
                if (config.ctkd) {
                    presetContent += `ctkd = ${config.ctkd}\n`;
                }
                if (config.ctvd) {
                    presetContent += `ctvd = ${config.ctvd}\n`;
                }
            }


            // Add speculation settings
            if (config.speculationType !== 'none' || config.ngramMod) {
                const specTypes = [];
                if (config.ngramMod) specTypes.push('ngram-mod');
                if (config.speculationType !== 'none') specTypes.push(config.speculationType);
                if (specTypes.length > 0) {
                    presetContent += `spec-type = ${specTypes.join(',')}\n`;
                }
                if (config.ngramMod) {
                    presetContent += `spec-ngram-size-n = 24\n`;
                    presetContent += `draft-min = 48\n`;
                    presetContent += `draft-max = 64\n`;
                }
                if (config.specDraftNMax > 0 && config.speculationType !== 'none') {
                    presetContent += `spec-draft-n-max = ${config.specDraftNMax}\n`;
                }
            }

            // Add reasoning setting
            if (config.reasoning !== undefined && config.reasoning !== 'auto') {
                presetContent += `reasoning = ${config.reasoning}\n`;
            } else if (config.disableReasoning !== undefined) {
                presetContent += `reasoning = ${config.disableReasoning ? 'off' : 'on'}\n`;
            }

            // Add a blank line between sections for readability
            presetContent += '\n';
        }

        return presetContent;
    }

    return { buildPresetIni: buildPresetIni };
});

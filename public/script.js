import { io } from "https://cdn.socket.io/4.8.1/socket.io.esm.min.js";

// DOM Elements
const serverPathInput = document.getElementById('serverPath');
const modelPathSelect = document.getElementById('modelPath');
const nglInput = document.getElementById('ngl');
const threadsInput = document.getElementById('threads');
const tempInput = document.getElementById('temp');
const topKInput = document.getElementById('topK');
const topPInput = document.getElementById('topP');
const repeatPenaltyInput = document.getElementById('repeatPenalty');
const presencePenaltyInput = document.getElementById('presencePenalty');
const mlockCheckbox = document.getElementById('mlock');
const swaFullCheckbox = document.getElementById('swaFull');
const noMmapCheckbox = document.getElementById('noMmap');
const dioCheckbox = document.getElementById('dio');
const contextSizeInput = document.getElementById('contextSize');
const nCpuMoeInput = document.getElementById('nCpuMoe');
const cpuMoeCheckbox = document.getElementById('cpuMoe');
const ctkEnableCheckbox = document.getElementById('ctkEnable');
const contextTokenKeySelect = document.getElementById('contextTokenKey');
const contextTokenValueSelect = document.getElementById('contextTokenValue');
const fastAttentionCheckbox = document.getElementById('fastAttention');
const jinjaCheckbox = document.getElementById('jinja');
const verboseCheckbox = document.getElementById('verbose');
const noKvOffloadCheckbox = document.getElementById('noKvOffload');
const noMmprojOffloadCheckbox = document.getElementById('noMmprojOffload');
const ngramModCheckbox = document.getElementById('ngramMod');
const disableReasoningCheckbox = document.getElementById('disableReasoning');
const launchBtn = document.getElementById('launchBtn');
const stopBtn = document.getElementById('stopBtn');
const restartBtn = document.getElementById('restartBtn'); // New restart button
const settingsBtn = document.getElementById('settingsBtn'); // New settings button
const modelStatusMessage = document.getElementById('modelStatusMessage');
const modelProcessInfo = document.getElementById('modelProcessInfo');
const modelOutput = document.getElementById('modelOutput');

// Configuration management elements
const configList = document.getElementById('configList');
const addConfigBtn = document.getElementById('addConfigBtn');
const configFormContainer = document.getElementById('configFormContainer');
const configFormTitle = document.getElementById('configFormTitle');
const configNameInput = document.getElementById('configName');
const saveConfigBtn = document.getElementById('saveConfigBtn');
const cancelConfigBtn = document.getElementById('cancelConfigBtn');
const launchPresetsSelect = document.querySelector('#launchPresetsSelect');

// Settings dialog elements
const settingsDialog = document.createElement('dialog');
settingsDialog.id = 'settingsDialog';
settingsDialog.className = 'settings-dialog';

// Add the settings dialog to the body
document.body.appendChild(settingsDialog);

// Store WebSocket connection
let socket = null;

// Configuration management state
let currentConfigId = null;
let configurations = {};

// Chart variables
let cpuCtx, ramCtx, gpuCtx, vramCtx;
let chartData = {
    cpu: [],
    ram: [],
    gpu: [],
    vram: []
};

// Disable/enable buttons based on status
function updateButtonStates(isRunning) {
    launchBtn.disabled = isRunning;
    stopBtn.disabled = !isRunning;
    // restartBtn.disabled = !isRunning; // Enable restart button when running
}

// Update status display
function updateStatus(isRunning) {
    if (isRunning) {
        modelStatusMessage.textContent = 'Running';
        modelStatusMessage.style.color = 'green';
    } else {
        modelStatusMessage.textContent = 'Not running';
        modelStatusMessage.style.color = 'red';
    }
}

// Show output in the pre element
function showOutput(message) {
    const timestamp = new Date().toISOString();
    modelOutput.textContent += `[${timestamp}] ${message}\n`;

    // Limit output to last 1000 lines
    const lines = modelOutput.textContent.split('\n');
    if (lines.length > 1000) {
        modelOutput.textContent = lines.slice(lines.length - 1000).join('\n');
    }

    modelOutput.scrollTop = modelOutput.scrollHeight;
}

// Fetch current status
async function fetchStatus() {
    try {
        const response = await fetch('/status');
        const data = await response.json();
        updateButtonStates(data.running);
        updateStatus(data.running);
        return data.running;
    } catch (error) {
        console.error('Error fetching models:', error);
        showOutput('Error fetching models: ' + error.message);
    }
}

// Fetch and populate models dropdown
async function fetchModels() {
    try {
        const response = await fetch('/models');
        const data = await response.json();
        window.models = data.models; // Store globally for later use
        
        if (data.success) {
            // Clear existing options except the placeholder
            modelPathSelect.innerHTML = '<option value="">-- Select a Model --</option>';
            // Also clear draft model dropdown
            document.getElementById('draftModelPath').innerHTML = '<option value="">-- Select a Draft Model --</option>';
            
            // Add models to both dropdowns
            data.models.forEach(model => {
                const option = document.createElement('option');
                option.value = model.path;  // Use full path for the value
                option.textContent = model.relativePath || model.name;  // Show relative path or just name
                
                // Add to main model dropdown
                modelPathSelect.appendChild(option);
                
                // Also add to draft model dropdown (clone the option)
                const draftOption = option.cloneNode(true);
                document.getElementById('draftModelPath').appendChild(draftOption);
            });
        } else {
            console.error('Failed to fetch models:', data.error);
            showOutput('Error fetching models: ' + data.error);
        }
    } catch (error) {
        console.error('Error fetching models:', error);
        showOutput('Error fetching models: ' + error.message);
    }
}

// Load configurations from localStorage
function loadConfigurations() {
    const savedConfigs = localStorage.getItem('llamaCppConfigs');
    if (savedConfigs) {
        configurations = JSON.parse(savedConfigs);
    } else {
        configurations = {};
    }
    return configurations;
}

// Save configurations to localStorage
function saveConfigurations() {
    localStorage.setItem('llamaCppConfigs', JSON.stringify(configurations));
}

// Get all configuration names
function getConfigNames() {
    return Object.keys(configurations);
}

// Create a new configuration with default name based on model
function createDefaultConfigName() {
    const modelName = modelPathSelect.options[modelPathSelect.selectedIndex]?.text || 'Default';
    // Extract just the model name without path and extension
    const cleanName = modelName.split('/').pop().split('\\').pop().replace(/\.[^/.]+$/, "") || 'Configuration';
    return cleanName;
}

// Save current values to configurations
function saveCurrentValues(configId) {
    if (!configId) return;
    
    const config = {
        serverPath: serverPathInput.value,
        modelPath: modelPathSelect.value,  // Use select value instead of input value
        ngl: parseInt(nglInput.value) || 0,
        threads: parseInt(threadsInput.value) || 1,
        temp: parseFloat(tempInput.value) || 0,
        topK: parseInt(topKInput.value) || 0,
        topP: parseFloat(topPInput.value) || 0,
        repeatPenalty: parseFloat(repeatPenaltyInput.value) || 0,
        presencePenalty: parseFloat(presencePenaltyInput.value) || 0,
        parallel: parseInt(document.getElementById('parallel').value) || 0,
        mlock: mlockCheckbox.checked,
        swaFull: swaFullCheckbox.checked,
        noMmap: noMmapCheckbox.checked,
        dio: dioCheckbox.checked,
        contextSize: parseInt(contextSizeInput.value) || 1,
        nCpuMoe: parseInt(nCpuMoeInput.value) || 0,
        cpuMoe: cpuMoeCheckbox.checked,
        ctkEnable: ctkEnableCheckbox.checked,
        contextTokenKey: contextTokenKeySelect.value,
        contextTokenValue: contextTokenValueSelect.value,
        fastAttention: fastAttentionCheckbox.value,
        jinja: jinjaCheckbox.checked,
        verbose: verboseCheckbox.checked,
        noKvOffload: noKvOffloadCheckbox.checked,
        noMmprojOffload: noMmprojOffloadCheckbox.checked,
        ngramMod: ngramModCheckbox.checked,
        disableReasoning: disableReasoningCheckbox.checked,
        draftModelPath: document.getElementById('draftModelPath') ? document.getElementById('draftModelPath').value.trim() : '',
        ngld: parseInt(document.getElementById('ngld') ? document.getElementById('ngld').value : 0) || 0,
        ctkd: document.getElementById('ctkd') ? document.getElementById('ctkd').value : '',
        ctvd: document.getElementById('ctvd') ? document.getElementById('ctvd').value : '',
        draftPMin: parseFloat(document.getElementById('draftPMin') ? document.getElementById('draftPMin').value : 0) || 0,
        draftMin: parseInt(document.getElementById('draftMin') ? document.getElementById('draftMin').value : 0) || 0,
        draftMax: parseInt(document.getElementById('draftMax') ? document.getElementById('draftMax').value : 0) || 0
    };
    
    configurations[configId] = config;
    saveConfigurations();
    
    // Debug logging
    console.log('Saved configuration:', configId, config);
}

// Load configuration values into form
function loadConfiguration(configId) {
    if (!configId || !configurations[configId]) return;
    
    const config = configurations[configId];
    currentConfigId = configId;
    
    // Load values into form fields
    if (config.serverPath) serverPathInput.value = config.serverPath;
    if (config.modelPath) modelPathSelect.value = config.modelPath;
    if (config.ngl !== undefined) nglInput.value = config.ngl;
    if (config.threads !== undefined) threadsInput.value = config.threads;
    if (config.temp !== undefined) tempInput.value = config.temp;
    if (config.topK !== undefined) topKInput.value = config.topK;
    if (config.topP !== undefined) topPInput.value = config.topP;
    if (config.repeatPenalty !== undefined) repeatPenaltyInput.value = config.repeatPenalty;
    if (config.presencePenalty !== undefined) presencePenaltyInput.value = config.presencePenalty;
    if (config.parallel !== undefined) document.getElementById('parallel').value = config.parallel;
    if (config.mlock !== undefined) mlockCheckbox.checked = config.mlock;
    if (config.swaFull !== undefined) swaFullCheckbox.checked = config.swaFull;
    noMmapCheckbox.checked = !!config.noMmap;
    dioCheckbox.checked = !!config.dio;
    if (config.contextSize !== undefined) contextSizeInput.value = config.contextSize;
    if (config.nCpuMoe !== undefined) nCpuMoeInput.value = config.nCpuMoe;
    if (config.cpuMoe !== undefined) cpuMoeCheckbox.checked = config.cpuMoe;
    if (config.ctkEnable !== undefined) ctkEnableCheckbox.checked = config.ctkEnable;
    if (config.contextTokenKey !== undefined) contextTokenKeySelect.value = config.contextTokenKey;
    if (config.contextTokenValue !== undefined) contextTokenValueSelect.value = config.contextTokenValue;
    if (config.fastAttention !== undefined) {
        // Handle fastAttention properly - it's a select element, not a checkbox
        fastAttentionCheckbox.value = config.fastAttention == true ? 'on': config.fastAttention;
    }
    if (config.jinja !== undefined) jinjaCheckbox.checked = config.jinja;
    noKvOffloadCheckbox.checked = !!config.noKvOffload;
    noMmprojOffloadCheckbox.checked = !!config.noMmprojOffload;
    ngramModCheckbox.checked = !!config.ngramMod;
    disableReasoningCheckbox.checked = !!config.disableReasoning;

    if(config.draftModelPath !== undefined) document.getElementById('draftModelPath').value = config.draftModelPath;
    if(config.ngld !== undefined) document.getElementById('ngld').value = config.ngld.toString();
    if(config.ctkd !== undefined) document.getElementById('ctkd').value = config.ctkd;
    if(config.ctvd !== undefined) document.getElementById('ctvd').value = config.ctvd;
    if(config.draftPMin !== undefined) document.getElementById('draftPMin').value = config.draftPMin.toString();
    if(config.draftMin !== undefined) document.getElementById('draftMin').value = config.draftMin.toString();
    if(config.draftMax !== undefined) document.getElementById('draftMax').value = config.draftMax.toString();
    
    // Debug logging for loaded configuration
    console.log('Loaded configuration:', configId, config);
    updateContextTokenEnableState();
}

// Update enable/disable state for context token parameters
function updateContextTokenEnableState() {
    const isEnabled = ctkEnableCheckbox.checked;
    contextTokenKeySelect.disabled = !isEnabled;
    contextTokenValueSelect.disabled = !isEnabled;
    
    // Ensure the dropdowns are properly enabled/disabled when loaded from config
    if (isEnabled) {
        contextTokenKeySelect.removeAttribute('disabled');
        contextTokenValueSelect.removeAttribute('disabled');
    } else {
        contextTokenKeySelect.setAttribute('disabled', 'disabled');
        contextTokenValueSelect.setAttribute('disabled', 'disabled');
    }
}

// Launch the server with all parameters
async function launchServer() {
    const serverPath = serverPathInput.value.trim();
    
    if (!serverPath) {
        alert('Please enter the path to llama-server.exe');
        return;
    }
    
    // Check if model is selected
    if (!modelPathSelect.value.trim()) {
        alert('Please select a model from the dropdown');
        return;
    }
    
    // Collect all configuration values
    const config = {
        modelPath: modelPathSelect.value.trim(),  // Use select value instead of input value
        ngl: parseInt(nglInput.value) || 0,
        threads: parseInt(threadsInput.value) || 1,
        temp: parseFloat(tempInput.value) || 0,
        topK: parseInt(topKInput.value) || 0,
        topP: parseFloat(topPInput.value) || 0,
        repeatPenalty: parseFloat(repeatPenaltyInput.value) || 0,
        presencePenalty: parseFloat(presencePenaltyInput.value) || 0,
        parallel: parseInt(document.getElementById('parallel').value) || 0,
        mlock: mlockCheckbox.checked,
        swaFull: swaFullCheckbox.checked,
        noMmap: noMmapCheckbox.checked,
        contextSize: parseInt(contextSizeInput.value) || 1,
        nCpuMoe: parseInt(nCpuMoeInput.value) || 0,
        cpuMoe: cpuMoeCheckbox.checked,
        dio: dioCheckbox.checked,
        noKvOffload: noKvOffloadCheckbox.checked,
        noMmprojOffload: noMmprojOffloadCheckbox.checked,
        ctkEnable: ctkEnableCheckbox.checked,
        contextTokenKey: contextTokenKeySelect.value,
        contextTokenValue: contextTokenValueSelect.value,
        fastAttention: fastAttentionCheckbox.value,
        jinja: jinjaCheckbox.checked,
        verbose: verboseCheckbox.checked,
        draftModelPath: document.getElementById('draftModelPath').value.trim(),
        ngramMod: ngramModCheckbox.checked,
        disableReasoning: disableReasoningCheckbox.checked,
        ngld: parseInt(document.getElementById('ngld').value) || 0,
        ctkd: document.getElementById('ctkd').value,
        ctvd: document.getElementById('ctvd').value,
        draftPMin: parseFloat(document.getElementById('draftPMin').value) || 0,
        draftMin: parseInt(document.getElementById('draftMin').value) || 0,
        draftMax: parseInt(document.getElementById('draftMax').value) || 0
    };
    
    // Save current values to localStorage (if we have a config ID)
    if (currentConfigId) {
        saveCurrentValues(currentConfigId);
    }
    
    try {
        showOutput(`Starting server: ${serverPath}`);
        showOutput('Connecting to server for real-time logging...');
        
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
        
        if (config.repeatPenalty > 0) {
            args.push('--repeat-penalty', config.repeatPenalty.toString());
        }
        
        if (config.presencePenalty > 0) {
            args.push('--presence-penalty', config.presencePenalty.toString());
        }
        
        // Add parallel parameter
        if (config.parallel > 0) {
            args.push('--parallel', config.parallel.toString());
        }
        
        if (config.mlock) {
            args.push('--mlock');
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
        
        // Add verbose flag if checked
        if (config.verbose) {
            args.push('--verbose');
        }

        // Add no-mmap flag if checked
        if (config.noMmap) {
            args.push('--no-mmap');
        }

        // Add no-kv-offload flag if checked
        if (config.noKvOffload) {
            args.push('--no-kv-offload');
        }

        // Add no-mmproj-offload flag if checked
        if (config.noMmprojOffload) {
            args.push('--no-mmproj-offload');
        }

        // Add no-direct-io flag if checked
        if (config.dio) {
            args.push('-dio');
        }

        // Add ngram-mod flags if checked
        if (config.ngramMod) {
            args.push('--spec-type', 'ngram-mod');
            args.push('--spec-ngram-size-n', '24');
            args.push('--draft-min', '48');
            args.push('--draft-max', '64');
        }

        // Add reasoning-budget flag if checked
        if (config.disableReasoning) {
            args.push('--reasoning-budget', '0');
        }

        // Add draft model parameters if specified
        if (config.draftModelPath) {
            args.push('-md', config.draftModelPath);
            if (config.ngld >= 0) {  // Allow 0 as a valid value
                args.push('-ngld', config.ngld.toString());
            }
            
            if (config.ctkd) {
                args.push('-ctkd', config.ctkd);
            }
            
            if (config.ctvd) {
                args.push('-ctvd', config.ctvd);
            }
            
            if (config.draftPMin >= 0) {  // Allow 0 as a valid value
                args.push('--draft-p-min', config.draftPMin.toString());
            }
            
            if (config.draftMin >= 0) {  // Allow 0 as a valid value
                args.push('--draft-min', config.draftMin.toString());
            }
            
            if (config.draftMax >= 0) {  // Allow 0 as a valid value
                args.push('--draft-max', config.draftMax.toString());
            }
        }

        args.push("--host", "0.0.0.0");
        args.push("-fit", "off");

        // mmproj loading
        const modelPath = modelPathSelect.value.trim();
        window.models.forEach(model => {
            if (model.path === modelPath && model.mmprojFile) {
                args.push('--mmproj', model.mmprojFile);
            }
        });
        
        showOutput(`Command arguments: ${args.join(' ')}`);
        
        const response = await fetch('/start', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                serverPath, 
                args 
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showOutput('Server started successfully');
            updateStatus(true);
            updateButtonStates(true);
            // Initialize WebSocket connection for log streaming
            initWebSocket();
        } else {
            showOutput('Error starting server: ' + data.error);
        }
    } catch (error) {
        console.error('Error launching server:', error);
        showOutput('Error launching server: ' + error.message);
    }
}

// Launch model presets functionality
async function launchModelPresets() {
    try {
        showOutput('Starting model presets process...');
        
        // Get all configurations from localStorage
        const savedConfigs = localStorage.getItem('llamaCppConfigs');
        if (!savedConfigs) {
            showOutput('No configurations found to create presets file');
            return;
        }
        
        const configs = JSON.parse(savedConfigs);
        if (Object.keys(configs).length === 0) {
            showOutput('No configurations found to create presets file');
            return;
        }
        
        // Convert configurations to models-preset.ini format
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
            window.models.forEach(model => {
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
            
            if (config.repeatPenalty !== undefined && config.repeatPenalty > 0) {
                presetContent += `repeat-penalty = ${config.repeatPenalty}\n`;
            }
            
            if (config.presencePenalty !== undefined && config.presencePenalty > 0) {
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
            
            
            if (config.mlock !== undefined && config.mlock) {
                presetContent += `mlock = true\n`;
            }
            
            if (config.swaFull !== undefined && config.swaFull) {
                presetContent += `swa-full = true\n`;
            }
            
            if (config.noMmap !== undefined && config.noMmap) {
                presetContent += `no-mmap = true\n`;
            }
            
            if (config.noKvOffload !== undefined && config.noKvOffload) {
                presetContent += `no-kv-offload = true\n`;
            }

            if (config.noMmprojOffload !== undefined && config.noMmprojOffload) {
                presetContent += `no-mmproj-offload = true\n`;
            }

            if (config.dio !== undefined && config.dio) {
                presetContent += `dio = true\n`;
            }
            
            if (config.jinja !== undefined && config.jinja) {
                presetContent += `jinja = true\n`;
            }
            
            if (config.verbose !== undefined && config.verbose) {
                presetContent += `verbose = true\n`;
            }

            
            // Add draft model parameters if available
            if (config.draftModelPath) {
                presetContent += `model-draft = ${config.draftModelPath}\n`;
            }
            
            if (config.ngld !== undefined && config.ngld >= 0) {
                presetContent += `ngld = ${config.ngld}\n`;
            }
            
            if (config.ctkd) {
                presetContent += `ctkd = ${config.ctkd}\n`;
            }
            
            if (config.ctvd) {
                presetContent += `ctvd = ${config.ctvd}\n`;
            }

             if (config.ctk) {
                presetContent += `ctk = ${config.ctk}\n`;
            }
            
            if (config.ctv) {
                presetContent += `ctv = ${config.ctv}\n`;
            }

            if (config.fastAttention) {
                presetContent += `fa = ${config.fastAttention ?? 'auto'}\n`;
            }
            
            if (config.draftPMin !== undefined && config.draftPMin >= 0) {
                presetContent += `draft-p-min = ${config.draftPMin}\n`;
            }
            
            if (config.draftMin !== undefined && config.draftMin >= 0) {
                presetContent += `draft-min = ${config.draftMin}\n`;
            }
            
            if (config.draftMax !== undefined && config.draftMax >= 0) {
                presetContent += `draft-max = ${config.draftMax}\n`;
            }
            
            // Add ngram-mod settings if enabled
            if (config.ngramMod !== undefined && config.ngramMod) {
                presetContent += `spec-type = ngram-mod\n`;
                presetContent += `spec-ngram-size-n = 24\n`;
                presetContent += `draft-min = 48\n`;
                presetContent += `draft-max = 64\n`;
            }
            
            // Add reasoning-budget setting if enabled
            if (config.disableReasoning !== undefined && config.disableReasoning) {
                presetContent += `reasoning-budget = 0\n`;
            }
            
            // Add a blank line between sections for readability
            presetContent += '\n';
        }
        
        showOutput('Generated models-preset.ini content:');
        showOutput(presetContent);
        
        // Send the presets to server for processing
        const response = await fetch('/launch-presets', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                presets: presetContent,
                serverPath: launchPresetsSelect.value
            })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showOutput('Model presets process started successfully');
            updateStatus(true);
            updateButtonStates(true);
            // Initialize WebSocket connection for log streaming
            initWebSocket();
        } else {
            showOutput('Error starting model presets: ' + data.error);
        }
    } catch (error) {
        console.error('Error launching model presets:', error);
        showOutput('Error launching model presets: ' + error.message);
    }
}

// Initialize WebSocket connection for log streaming
function initWebSocket() {
    // Only initialize if not already connected
    if (socket) return;
    
    try {
        // Connect to the server's WebSocket endpoint
        socket = io();
        
        socket.on('connect', () => {
            console.log('Connected to WebSocket server for log streaming');
            showOutput('Connected to server for real-time logging');
        });
        
        socket.on('log-stream', (data) => {
            // Stream logs to output box
            if (data && data.data) {
                showOutput(data.data.trim());
            }
        });
        
        socket.on('server-ended', (data) => {
            console.log('Server process ended:', data.message);
            showOutput('Server process has ended');
            updateStatus(false);
            updateButtonStates(false);
        });
        
        socket.on('server-error', (data) => {
            console.error('Server error:', data.message);
            showOutput('Server error: ' + data.message);
        });
        
        socket.on('disconnect', () => {
            console.log('Disconnected from WebSocket server');
            showOutput('Disconnected from server for real-time logging');
        });
    } catch (error) {
        console.error('Failed to initialize WebSocket:', error);
        showOutput('Failed to connect to server for real-time logging: ' + error.message);
    }
}

// Stop the server
async function stopServer() {
    try {
        showOutput('Stopping server...');
        const response = await fetch('/stop', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
        });
        const data = await response.json();
        
        if (data.success) {
            showOutput('Server stopped successfully');
            updateStatus(false);
            updateButtonStates(false);
            // Close WebSocket connection
            if (socket) {
                socket.disconnect();
                socket = null;
            }
        } else {
            showOutput('Error stopping server: ' + data.error);
        }
    } catch (error) {
        console.error('Error stopping server:', error);
        showOutput('Error stopping server: ' + error.message);
    }
}

// Restart the server using the last launch configuration
async function restartServer() {
    try {
        showOutput('Restarting server...');
        const response = await fetch('/restart', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
        });
        const data = await response.json();
        
        if (data.success) {
            showOutput('Server restarted successfully');
            updateStatus(true);
            updateButtonStates(true);
            // Initialize WebSocket connection for log streaming
            initWebSocket();
        } else {
            showOutput('Error restarting server: ' + data.error);
        }
    } catch (error) {
        console.error('Error restarting server:', error);
        showOutput('Error restarting server: ' + error.message);
    }
}

// Configuration management functions
function renderConfigList() {
    configList.innerHTML = '';
    
    const configNames = getConfigNames();
    if (configNames.length === 0) {
        configList.innerHTML = '<div class="empty-configs">No configurations saved</div>';
        return;
    }
    
    // Sort configurations by name for consistent display
    configNames.sort().forEach(name => {
        const configItem = document.createElement('div');
        configItem.className = 'config-item';
        if (currentConfigId === name) {
            configItem.classList.add('active');
        }
        
        configItem.innerHTML = `
            <span class="config-item-name">${name}</span>
            <div class="config-item-actions">
                <button class="config-item-btn edit-btn" data-name="${name}" aria-label="Edit">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M11 4H4C3.46957 4 2.96086 4.21071 2.58579 4.58579C2.21071 4.96086 2 5.46957 2 6V20C2 20.5304 2.21071 21.0391 2.58579 21.4142C2.96086 21.7893 3.46957 22 4 22H18C18.5304 22 19.0391 21.7893 19.4142 21.4142C19.7893 21.0391 20 20.5304 20 20V13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <path d="M18.5 2.50001C18.8978 2.10288 19.4374 1.87868 20 1.87868C20.5626 1.87868 21.1022 2.10288 21.5 2.50001C21.8978 2.89715 22.122 3.43675 22.122 4.00001C22.122 4.56327 21.8978 5.10287 21.5 5.50001L12 15L8 16L9 12L18.5 2.50001Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
                <button class="config-item-btn delete-btn" data-name="${name}" aria-label="Delete">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M3 6H5H21" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <path d="M19 6V20C19 20.5304 18.7893 21.0391 18.4142 21.4142C18.0391 21.7893 17.5304 22 17 22H7C6.46957 22 5.96086 21.7893 5.58579 21.4142C5.21071 21.0391 5 20.5304 5 20V6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                        <path d="M8 6V4C8 3.46957 8.21071 2.96086 8.58579 2.58579C8.96086 2.21071 9.46957 2 10 2H14C14.5304 2 15.0391 2.21071 15.4142 2.58579C15.7893 2.96086 16 3.46957 16 4V6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                </button>
            </div>
        `;
        
        configList.appendChild(configItem);
    });
    
    // Add event listeners for config items
    document.querySelectorAll('.config-item-btn.edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const configName = btn.dataset.name;
            editConfiguration(configName);
        });
    });
    
    document.querySelectorAll('.config-item-btn.delete-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const configName = btn.dataset.name;
            deleteConfiguration(configName);
        });
    });
    
    // Add click event for selecting configurations
    document.querySelectorAll('.config-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.classList.contains('config-item-btn')) return;
            const configName = e.currentTarget.querySelector('.config-item-name').textContent;
            selectConfiguration(configName);
        });
    });
}

// Select a configuration to use
function selectConfiguration(configName) {
    if (configurations[configName]) {
        loadConfiguration(configName);
        currentConfigId = configName;
        renderConfigList();
    }
}

// Edit a configuration
function editConfiguration(configName) {
    const config = configurations[configName];
    if (config) {
        // Show the form with the configuration name
        configFormTitle.textContent = 'Edit Configuration';
        configNameInput.value = configName || '';
        configFormContainer.showModal();
        currentConfigId = configName;
    }
}

// Save a new or edited configuration
function saveConfiguration() {
    const configName = configNameInput.value.trim();
    
    if (!configName) {
        alert('Please enter a configuration name');
        return;
    }
    
    // Save the current form values to this configuration
    saveCurrentValues(configName);
    
    // Close the form and refresh the list
    configFormContainer.close();
    renderConfigList();
    
    // Clear the form
    configNameInput.value = '';
    configFormTitle.textContent = 'Create New Configuration';
}

// Cancel configuration editing
function cancelConfiguration() {
    configFormContainer.close();
    configNameInput.value = '';
    configFormTitle.textContent = 'Create New Configuration';
}

// Delete a configuration
function deleteConfiguration(configName) {
    if (confirm(`Are you sure you want to delete the configuration "${configName}"?`)) {
        delete configurations[configName];
        saveConfigurations();
        renderConfigList();
        
        // If we just deleted the current config, clear the form
        if (currentConfigId === configName) {
            currentConfigId = null;
            // Clear all fields
            serverPathInput.value = '';
            modelPathSelect.value = '';
            nglInput.value = '99';
            threadsInput.value = '12';
            tempInput.value = '0.7';
            topKInput.value = '20';
            topPInput.value = '0.00';
            repeatPenaltyInput.value = '1.05';
            mlockCheckbox.checked = false;
            swaFullCheckbox.checked = false;
            noMmapCheckbox.checked = false;
            noMmprojOffloadCheckbox.checked = false;
            dioCheckbox.checked = false;
            contextSizeInput.value = '16384';
            nCpuMoeInput.value = '8';
            cpuMoeCheckbox.checked = false;
            ctkEnableCheckbox.checked = false;
            contextTokenKeySelect.value = 'f16';
            contextTokenValueSelect.value = 'f16';
            // Fix: Set fastAttention to its default value instead of checked state
            fastAttentionCheckbox.value = 'auto';
        }
    }
}

// Add a new configuration
function addNewConfiguration() {
    configFormTitle.textContent = 'Create New Configuration';
    configNameInput.value = '';
    configFormContainer.showModal();
    currentConfigId = null;
}

// Initialize the application
async function init() {
    // Load configurations
    loadConfigurations();
    
    await fetchModels();
    
    // Set up event listeners for configuration management
    addConfigBtn.addEventListener('click', addNewConfiguration);
    saveConfigBtn.addEventListener('click', saveConfiguration);
    cancelConfigBtn.addEventListener('click', cancelConfiguration);
    
// Set up event listeners for context token parameters
    ctkEnableCheckbox.addEventListener('change', updateContextTokenEnableState);
    
    // Initialize the state on page load
    updateContextTokenEnableState();
    
    // Set up event listeners for launching and stopping
    launchBtn.addEventListener('click', launchServer);
    stopBtn.addEventListener('click', stopServer);
    // restartBtn.addEventListener('click', restartServer); // Add restart button listener
    
    // Add event listener for the new Launch Model Presets button
    const launchPresetsBtn = document.querySelector('#launchPresetsBtn');

   
    launchPresetsBtn.addEventListener('click', launchModelPresets);
    
    // Check initial status
    await fetchStatus();
    
    // Periodically check status (every 5 seconds)
    setInterval(fetchStatus, 5000);
    
    // Render the configuration list
    renderConfigList();
}

 // Function to populate the dropdown with server paths from configurations
function populateLaunchPresetsDropdown() {

    // Clear existing options except the placeholder
    launchPresetsSelect.innerHTML = '<option value="">-- Select Server Path --</option>';
    
    // Get all configurations
    const savedConfigs = localStorage.getItem('llamaCppConfigs');
    if (!savedConfigs) return;
    
    const configs = JSON.parse(savedConfigs);
    const serverPaths = new Set(); // Use Set to avoid duplicates
    
    // Collect unique server paths from all configurations
    for (const [configName, config] of Object.entries(configs)) {
        if (config.serverPath && config.serverPath.trim()) {
            serverPaths.add(config.serverPath.trim());
        }
    }
    
    // Add options to dropdown
    serverPaths.forEach(path => {
        const option = document.createElement('option');
        option.value = path;
        option.textContent = path;
        launchPresetsSelect.appendChild(option);
    });
}


// Initialize chart contexts and set canvas dimensions
function initCharts() {
    const cpuCanvas = document.getElementById('cpuGraph');
    const ramCanvas = document.getElementById('ramGraph');
    const gpuCanvas = document.getElementById('gpuGraph');
    const vramCanvas = document.getElementById('vramGraph');
    
    // Set canvas dimensions to match their CSS dimensions
    function setCanvasSize(canvas) {
        if (canvas) {
            const style = window.getComputedStyle(canvas);
            const width = parseInt(style.width) || canvas.offsetWidth;
            const height = parseInt(style.height) || canvas.offsetHeight;
            
            // Set the actual canvas dimensions (this is important for proper rendering)
            canvas.width = width;
            canvas.height = height;
        }
    }
    
    if (cpuCanvas) {
        setCanvasSize(cpuCanvas);
        cpuCtx = cpuCanvas.getContext('2d');
    }
    if (ramCanvas) {
        setCanvasSize(ramCanvas);
        ramCtx = ramCanvas.getContext('2d');
    }
    if (gpuCanvas) {
        setCanvasSize(gpuCanvas);
        gpuCtx = gpuCanvas.getContext('2d');
    }
    if (vramCanvas) {
        setCanvasSize(vramCanvas);
        vramCtx = vramCanvas.getContext('2d');
    }
}

// Draw CPU usage chart
function drawCpuChart() {
    if (!cpuCtx || chartData.cpu.length === 0) return;
    
    const canvas = cpuCtx.canvas;
    const width = canvas.width;
    const height = canvas.height;
    
    // Clear canvas
    cpuCtx.clearRect(0, 0, width, height);
    
    // Draw grid lines
    cpuCtx.strokeStyle = '#444';
    cpuCtx.lineWidth = 1;
    cpuCtx.beginPath();
    for (let i = 0; i <= 10; i++) {
        const x = (i / 10) * width;
        cpuCtx.moveTo(x, 0);
        cpuCtx.lineTo(x, height);
    }
    cpuCtx.stroke();
    
    // Draw data line
    cpuCtx.strokeStyle = '#4CAF50';
    cpuCtx.lineWidth = 2;
    cpuCtx.beginPath();
    
    const maxDataPoints = Math.min(chartData.cpu.length, 50); // Limit to last 50 points
    const stepX = width / (maxDataPoints - 1);
    
    for (let i = 0; i < maxDataPoints; i++) {
        const x = i * stepX;
        const value = chartData.cpu[chartData.cpu.length - maxDataPoints + i];
        const y = height - (value / 100) * height;
        
        if (i === 0) {
            cpuCtx.moveTo(x, y);
        } else {
            cpuCtx.lineTo(x, y);
        }
    }
    cpuCtx.stroke();
}

// Draw RAM usage chart
function drawRamChart() {
    if (!ramCtx || chartData.ram.length === 0) return;
    
    const canvas = ramCtx.canvas;
    const width = canvas.width;
    const height = canvas.height;
    
    // Clear canvas
    ramCtx.clearRect(0, 0, width, height);
    
    // Draw grid lines
    ramCtx.strokeStyle = '#444';
    ramCtx.lineWidth = 1;
    ramCtx.beginPath();
    for (let i = 0; i <= 10; i++) {
        const x = (i / 10) * width;
        ramCtx.moveTo(x, 0);
        ramCtx.lineTo(x, height);
    }
    ramCtx.stroke();
    
    // Draw data line
    ramCtx.strokeStyle = '#2196F3';
    ramCtx.lineWidth = 2;
    ramCtx.beginPath();
    
    const maxDataPoints = Math.min(chartData.ram.length, 50); // Limit to last 50 points
    const stepX = width / (maxDataPoints - 1);
    
    for (let i = 0; i < maxDataPoints; i++) {
        const x = i * stepX;
        const value = chartData.ram[chartData.ram.length - maxDataPoints + i];
        const y = height - (value / 100) * height;
        
        if (i === 0) {
            ramCtx.moveTo(x, y);
        } else {
            ramCtx.lineTo(x, y);
        }
    }
    ramCtx.stroke();
}

// Draw GPU usage chart
function drawGpuChart() {
    if (!gpuCtx || chartData.gpu.length === 0) return;
    
    const canvas = gpuCtx.canvas;
    const width = canvas.width;
    const height = canvas.height;
    
    // Clear canvas
    gpuCtx.clearRect(0, 0, width, height);
    
    // Draw grid lines
    gpuCtx.strokeStyle = '#444';
    gpuCtx.lineWidth = 1;
    gpuCtx.beginPath();
    for (let i = 0; i <= 10; i++) {
        const x = (i / 10) * width;
        gpuCtx.moveTo(x, 0);
        gpuCtx.lineTo(x, height);
    }
    gpuCtx.stroke();
    
    // Draw data line
    gpuCtx.strokeStyle = '#FF9800';
    gpuCtx.lineWidth = 2;
    gpuCtx.beginPath();
    
    const maxDataPoints = Math.min(chartData.gpu.length, 50); // Limit to last 50 points
    const stepX = width / (maxDataPoints - 1);
    
    for (let i = 0; i < maxDataPoints; i++) {
        const x = i * stepX;
        const value = chartData.gpu[chartData.gpu.length - maxDataPoints + i];
        const y = height - (value / 100) * height;
        
        if (i === 0) {
            gpuCtx.moveTo(x, y);
        } else {
            gpuCtx.lineTo(x, y);
        }
    }
    gpuCtx.stroke();
}

// Draw VRAM usage chart
function drawVramChart() {
    if (!vramCtx || chartData.vram.length === 0) return;
    
    const canvas = vramCtx.canvas;
    const width = canvas.width;
    const height = canvas.height;
    
    // Clear canvas
    vramCtx.clearRect(0, 0, width, height);
    
    // Draw grid lines
    vramCtx.strokeStyle = '#444';
    vramCtx.lineWidth = 1;
    vramCtx.beginPath();
    for (let i = 0; i <= 10; i++) {
        const x = (i / 10) * width;
        vramCtx.moveTo(x, 0);
        vramCtx.lineTo(x, height);
    }
    vramCtx.stroke();
    
    // Draw data line
    vramCtx.strokeStyle = '#9C27B0';
    vramCtx.lineWidth = 2;
    vramCtx.beginPath();
    
    const maxDataPoints = Math.min(chartData.vram.length, 50); // Limit to last 50 points
    const stepX = width / (maxDataPoints - 1);
    
    for (let i = 0; i < maxDataPoints; i++) {
        const x = i * stepX;
        const value = chartData.vram[chartData.vram.length - maxDataPoints + i];
        const y = height - (value / 100) * height;
        
        if (i === 0) {
            vramCtx.moveTo(x, y);
        } else {
            vramCtx.lineTo(x, y);
        }
    }
    vramCtx.stroke();
}

// Update all charts with new data
function updateCharts() {
    drawCpuChart();
    drawRamChart();
    drawGpuChart();
    drawVramChart();
}

// Fetch system metrics and update charts
async function fetchSystemMetrics() {
    try {
        const response = await fetch('/metrics');
        const data = await response.json();
        
        if (data.cpu !== undefined) {
            chartData.cpu.push(data.cpu);
            if (chartData.cpu.length > 50) {
                chartData.cpu.shift(); // Remove oldest point
            }
            document.getElementById('cpuValue').textContent = `${Math.round(data.cpu)}%`;
        }
        
        if (data.ram !== undefined) {
            chartData.ram.push(data.ram);
            if (chartData.ram.length > 50) {
                chartData.ram.shift(); // Remove oldest point
            }
            document.getElementById('ramValue').textContent = `${Math.round(data.ram)}%`;
        }
        
        if (data.gpu !== undefined) {
            chartData.gpu.push(data.gpu);
            if (chartData.gpu.length > 50) {
                chartData.gpu.shift(); // Remove oldest point
            }
            document.getElementById('gpuValue').textContent = `${Math.round(data.gpu)}%`;
        }
        
        if (data.vram !== undefined) {
            chartData.vram.push(data.vram);
            if (chartData.vram.length > 50) {
                chartData.vram.shift(); // Remove oldest point
            }
            document.getElementById('vramValue').textContent = `${Math.round(data.vram)}%`;
        }
        
        updateCharts();
    } catch (error) {
        console.error('Error fetching system metrics:', error);
    }
}

// Start periodic metric updates
function startMetricUpdates() {
    // Update every second
    setInterval(fetchSystemMetrics, 1000);
    
    // Initial fetch
    fetchSystemMetrics();
}

// Handle window resize for charts
function handleResize() {
    // Reinitialize charts when window is resized to ensure proper canvas dimensions
    setTimeout(() => {
        initCharts();
        updateCharts();
    }, 100); // Small delay to ensure DOM is updated
}

// Open settings dialog
function openSettingsDialog() {
    fetch('/settings')
        .then(response => response.json())
        .then(data => {
            if (data.success) {
                const currentDirectory = data.settings.modelsDirectory || '';
                settingsDialog.innerHTML = `
                    <h3>Settings</h3>
                    <div class="form-group">
                        <label for="modelsDirectory">Models Directory:</label>
                        <input type="text" id="modelsDirectory" class="form-control" value="${currentDirectory}" placeholder="Enter models directory path">
                    </div>
                    <div class="form-actions">
                        <button id="saveSettingsBtn" class="btn btn-primary">Save</button>
                        <button id="cancelSettingsBtn" class="btn btn-secondary">Cancel</button>
                    </div>
                `;
                
                // Add event listeners to the dialog buttons
                const saveSettingsBtn = settingsDialog.querySelector('#saveSettingsBtn');
                const cancelSettingsBtn = settingsDialog.querySelector('#cancelSettingsBtn');
                const modelsDirectoryInput = settingsDialog.querySelector('#modelsDirectory');
                
                saveSettingsBtn.addEventListener('click', () => {
                    const directory = modelsDirectoryInput.value.trim();
                    if (!directory) {
                        alert('Please enter a models directory path');
                        return;
                    }
                    
                    // Save the settings
                    fetch('/settings', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({ modelsDirectory: directory })
                    })
                    .then(response => response.json())
                    .then(data => {
                        if (data.success) {
                            showOutput('Settings saved successfully');
                            settingsDialog.close();
                            // Refresh the page to reload models with new directory
                            location.reload();
                        } else {
                            showOutput('Error saving settings: ' + data.error);
                        }
                    })
                    .catch(error => {
                        console.error('Error saving settings:', error);
                        showOutput('Error saving settings: ' + error.message);
                    });
                });
                
                cancelSettingsBtn.addEventListener('click', () => {
                    settingsDialog.close();
                });
                
                // Show the dialog
                settingsDialog.showModal();
            } else {
                showOutput('Error fetching settings: ' + data.error);
            }
        })
        .catch(error => {
            console.error('Error fetching settings:', error);
            showOutput('Error fetching settings: ' + error.message);
        });
}

// Start the application when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    init();
    initCharts(); // Initialize chart contexts
    startMetricUpdates(); // Start periodic metric updates
    populateLaunchPresetsDropdown();
    
    // Add resize listener for charts
    window.addEventListener('resize', handleResize);
    
    // Set up settings button event listener
    settingsBtn.addEventListener('click', openSettingsDialog);
});

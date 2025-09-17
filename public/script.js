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
const mlockCheckbox = document.getElementById('mlock');
const swaFullCheckbox = document.getElementById('swaFull');
const contextSizeInput = document.getElementById('contextSize');
const nCpuMoeInput = document.getElementById('nCpuMoe');
const cpuMoeCheckbox = document.getElementById('cpuMoe');
const ctkEnableCheckbox = document.getElementById('ctkEnable');
const contextTokenKeySelect = document.getElementById('contextTokenKey');
const contextTokenValueSelect = document.getElementById('contextTokenValue');
const fastAttentionCheckbox = document.getElementById('fastAttention');
const jinjaCheckbox = document.getElementById('jinja');
const verboseCheckbox = document.getElementById('verbose');
const launchBtn = document.getElementById('launchBtn');
const stopBtn = document.getElementById('stopBtn');
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
        console.error('Error fetching status:', error);
        showOutput('Error checking status: ' + error.message);
        return false;
    }
}

// Fetch and populate models dropdown
async function fetchModels() {
    try {
        const response = await fetch('/models');
        const data = await response.json();
        
        if (data.success) {
            // Clear existing options except the placeholder
            modelPathSelect.innerHTML = '<option value="">-- Select a Model --</option>';
            
            // Add models to dropdown
            data.models.forEach(model => {
                const option = document.createElement('option');
                option.value = model.path;  // Use full path for the value
                option.textContent = model.relativePath || model.name;  // Show relative path or just name
                modelPathSelect.appendChild(option);
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
        mlock: mlockCheckbox.checked,
        swaFull: swaFullCheckbox.checked,
        contextSize: parseInt(contextSizeInput.value) || 1,
        nCpuMoe: parseInt(nCpuMoeInput.value) || 0,
        cpuMoe: cpuMoeCheckbox.checked,
        ctkEnable: ctkEnableCheckbox.checked,
        contextTokenKey: contextTokenKeySelect.value,
        contextTokenValue: contextTokenValueSelect.value,
        fastAttention: fastAttentionCheckbox.value,
        jinja: jinjaCheckbox.checked,
        verbose: verboseCheckbox.checked
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
    if (config.mlock !== undefined) mlockCheckbox.checked = config.mlock;
    if (config.swaFull !== undefined) swaFullCheckbox.checked = config.swaFull;
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
    
    // Debug logging for loaded configuration
    console.log('Loaded configuration:', configId, config);
}

// Update enable/disable state for context token parameters
function updateContextTokenEnableState() {
    const isEnabled = ctkEnableCheckbox.checked;
    contextTokenKeySelect.disabled = !isEnabled;
    contextTokenValueSelect.disabled = !isEnabled;
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
        mlock: mlockCheckbox.checked,
        swaFull: swaFullCheckbox.checked,
        contextSize: parseInt(contextSizeInput.value) || 1,
        nCpuMoe: parseInt(nCpuMoeInput.value) || 0,
        cpuMoe: cpuMoeCheckbox.checked,
        ctkEnable: ctkEnableCheckbox.checked,
        contextTokenKey: contextTokenKeySelect.value,
        contextTokenValue: contextTokenValueSelect.value,
        fastAttention: fastAttentionCheckbox.value,
        jinja: jinjaCheckbox.checked,
        verbose: verboseCheckbox.checked
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
                <button class="config-item-btn edit-btn" data-name="${name}">✏️</button>
                <button class="config-item-btn delete-btn" data-name="${name}">🗑️</button>
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
    
    // Set up event listeners for launching and stopping
    launchBtn.addEventListener('click', launchServer);
    stopBtn.addEventListener('click', stopServer);
    
    // Check initial status
    await fetchStatus();
    
    // Periodically check status (every 5 seconds)
    setInterval(fetchStatus, 5000);
    
    // Render the configuration list
    renderConfigList();
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

// Start the application when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    init();
    initCharts(); // Initialize chart contexts
    startMetricUpdates(); // Start periodic metric updates
    
    // Add resize listener for charts
    window.addEventListener('resize', handleResize);
});

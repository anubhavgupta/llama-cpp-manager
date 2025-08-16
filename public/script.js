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
const launchBtn = document.getElementById('launchBtn');
const stopBtn = document.getElementById('stopBtn');
const statusMessage = document.getElementById('statusMessage');
const processInfo = document.getElementById('processInfo');
const output = document.getElementById('output');

// Store WebSocket connection
let socket = null;

// Disable/enable buttons based on status
function updateButtonStates(isRunning) {
    launchBtn.disabled = isRunning;
    stopBtn.disabled = !isRunning;
}

// Update status display
function updateStatus(isRunning) {
    if (isRunning) {
        statusMessage.textContent = 'Running';
        statusMessage.style.color = 'green';
    } else {
        statusMessage.textContent = 'Not running';
        statusMessage.style.color = 'red';
    }
}

// Show output in the pre element
function showOutput(message) {
    const timestamp = new Date().toISOString();
    output.textContent += `[${timestamp}] ${message}\n`;
    output.scrollTop = output.scrollHeight;
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

// Load saved values from localStorage
function loadSavedValues() {
    const savedValues = JSON.parse(localStorage.getItem('llamaCppConfig') || '{}');
    
    if (savedValues.serverPath) serverPathInput.value = savedValues.serverPath;
    if (savedValues.modelPath) modelPathSelect.value = savedValues.modelPath;
    if (savedValues.ngl !== undefined) nglInput.value = savedValues.ngl;
    if (savedValues.threads !== undefined) threadsInput.value = savedValues.threads;
    if (savedValues.temp !== undefined) tempInput.value = savedValues.temp;
    if (savedValues.topK !== undefined) topKInput.value = savedValues.topK;
    if (savedValues.topP !== undefined) topPInput.value = savedValues.topP;
    if (savedValues.repeatPenalty !== undefined) repeatPenaltyInput.value = savedValues.repeatPenalty;
    if (savedValues.mlock !== undefined) mlockCheckbox.checked = savedValues.mlock;
    if (savedValues.swaFull !== undefined) swaFullCheckbox.checked = savedValues.swaFull;
    if (savedValues.contextSize !== undefined) contextSizeInput.value = savedValues.contextSize;
    if (savedValues.nCpuMoe !== undefined) nCpuMoeInput.value = savedValues.nCpuMoe;
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

// Save current values to localStorage
function saveCurrentValues() {
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
        cpuMoe: cpuMoeCheckbox.checked
    };
    
    localStorage.setItem('llamaCppConfig', JSON.stringify(config));
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
        cpuMoe: cpuMoeCheckbox.checked
    };
    
    // Save current values to localStorage
    saveCurrentValues();
    
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
            // Initialize WebSocket connection for logging
            initWebSocket();
        } else {
            showOutput('Error starting server: ' + data.error);
        }
    } catch (error) {
        console.error('Error launching server:', error);
        showOutput('Error launching server: ' + error.message);
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

// Initialize the application
async function init() {
    // Load saved values from localStorage
    loadSavedValues();
    fetchModels();
    // Set up event listeners
    launchBtn.addEventListener('click', launchServer);
    stopBtn.addEventListener('click', stopServer);
    
    // Check initial status
    await fetchStatus();
    
    // Periodically check status (every 5 seconds)
    setInterval(fetchStatus, 5000);
}

// Start the application when DOM is loaded
document.addEventListener('DOMContentLoaded', init);

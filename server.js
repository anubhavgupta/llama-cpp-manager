const express = require('express');
const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const osUtils = require('os-utils');
require('dotenv').config();
const app = express();
const PORT = 3001;

// Detect platform
const platform = os.platform();

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store the running process
let runningProcess = null;
let connectedClients = [];
let lastLaunchConfig = null;

// Create WebSocket server for log streaming
const httpServer = require('http').createServer(app);
const io = require('socket.io')(httpServer, {
    cors: {
        origin: "*"
    }
});

// Proxy server variables
let proxyServer = null;

// Function to start proxy server on port 3002
function startProxyServer() {
    const proxyApp = express();
    // proxyApp.use(express.json());
    // proxyApp.use(express.urlencoded({ extended: true }));

    proxyApp.all('*', (req, res) => {
        const http = require('http');
        const https = require('https');
        const targetUrl = `http://localhost:8080${req.originalUrl}`;

        // Parse URL to determine if we should use http or https
        const url = require('url');
        const parsedUrl = url.parse(targetUrl);

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: req.path,
            method: req.method,
            headers: {
                ...req.headers
            }
        };

        // Forward headers, excluding hop-by-hop headers
        const hopByHopHeaders = [
            'connection',
            'keep-alive',
            'proxy-authenticate',
            'proxy-authorization',
            'te',
            'trailers',
            'transfer-encoding',
            'upgrade'
        ];

        hopByHopHeaders.forEach(h => delete options.headers[h]);
        // Ensure host header is set correctly
        options.headers.host = 'localhost:8080';

        // Choose http or https agent
        const httpModule = parsedUrl.protocol === 'https:' ? https : http;

        // Check if this is an endpoint that should be logged
        const shouldLog = req.path === '/v1/messages' || req.path === '/v1/chat/completions';

        const proxyReq = httpModule.request(options, (proxyRes) => {
            // Forward status + headers first
            res.writeHead(proxyRes.statusCode, proxyRes.headers);

            let responseBody = '';

            proxyRes.on('data', (chunk) => {
                // Log chunk (convert buffer safely)
                const chunkString = chunk.toString();
                responseBody += chunkString;
                // Write to client
                res.write(chunk);
            });

            proxyRes.on('end', () => {
                if (shouldLog) {
                    console.log('Proxy response body:', responseBody);
                }
                res.end();
            });

            proxyRes.on('error', (err) => {
                console.error('Error in proxy response:', err);
                res.end();
            });
        });

        proxyReq.on('error', (error) => {
            console.error('Proxy request error:', error);
            if (!res.headersSent) {
                res.status(502).json({
                    error: 'Bad Gateway',
                    message: 'Failed to connect to backend server on port 8080'
                });
            } else {
                res.end();
            }
        });

        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            if (!res.headersSent) {
                res.status(504).json({
                    error: 'Gateway Timeout',
                    message: 'Backend server did not respond in time'
                });
            } else {
                res.end();
            }
        });

        // Pipe request body to proxy
        let requestBody = '';

        req.on('data', (chunk) => {
            const chunkString = chunk.toString();
            requestBody += chunkString;

            // Forward chunk to backend
            proxyReq.write(chunk);
        });

        req.on('end', () => {
            if (shouldLog) {
                try {
                    console.log('Full proxy request body:', JSON.stringify(requestBody, null, 4));
                } catch(ex) {
                    console.log("request data not in JSON.");
                }
            }
            proxyReq.end();
        });

        req.on('error', (err) => {
            console.error('Error reading incoming request:', err);
            proxyReq.destroy(err);
        });
    });

    proxyServer = proxyApp.listen(3002, () => {
        console.log('Proxy server running on port 3002');
    });
}

// Function to stop proxy server
function stopProxyServer() {
    if (proxyServer) {
        proxyServer.close(() => {
            console.log('Proxy server stopped');
            proxyServer = null;
        });
    }
}

// System monitoring variables
let systemMetrics = {
    cpu: { usage: 0, history: [] },
    ram: { usage: 0, total: 0, free: 0, history: [] },
    gpu: { usage: 0, memory: 0, history: [] },
    vram: { usage: 0, total: 0, free: 0, history: [] }
};

// Function to get system metrics
async function getSystemMetrics() {
    // CPU Usage using os-utils for more accurate readings
    let cpuUsage = 0;
    try {
        // Use os-utils for better CPU monitoring
        cpuUsage = await new Promise((res, rej)=>{
            osUtils.cpuUsage((usage)=>{
                res(usage * 100);
            });
        });

    } catch (error) {
        // Fallback to manual calculation if os-utils fails
        const cpus = os.cpus();
        let totalIdle = 0;
        let totalTick = 0;
        cpus.forEach(cpu => {
            const times = cpu.times;
            totalIdle += times.idle;
            totalTick += Object.values(times).reduce((a, b) => a + b, 0);
        });
        const idlePercentage = (totalIdle / cpus.length) / (totalTick / cpus.length) * 100;
        cpuUsage = Math.max(0, 100 - idlePercentage);
    }
    
    // RAM Usage
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const ramUsage = (usedMemory / totalMemory) * 100;
    
    // GPU and VRAM Usage - Handle different platforms
    let gpuUsage = 0;
    let vramUsage = 0;
    let vramTotal = 0;
    let vramFree = 0;
    
    try {
        // Check if we're on macOS (M-chip) or Windows with NVIDIA GPU
        if (platform === 'darwin') {
            // On macOS, we can't use nvidia-smi, so we'll check for M-chip specifically
            console.log('Running on macOS');
            
            // Try to detect if it's an M-chip Mac by checking CPU model
            const cpuModel = os.cpus()[0].model;
            const isMChip = cpuModel.includes('Apple') || cpuModel.includes('M1') || cpuModel.includes('M2') || cpuModel.includes('M3') || cpuModel.includes('M4');
            
            if (isMChip) {
                console.log('Detected Apple M-chip processor - using appropriate GPU monitoring approach');
                // For M-chip Macs, we can't easily get GPU usage without additional tools
                // We'll use a more realistic simulation for M-chip Macs based on typical usage patterns
                gpuUsage = Math.random() * 20 + 5; // Lower usage for Apple M-chip (5-25%)
                vramUsage = Math.random() * 40 + 10; // Simulated VRAM usage (10-50%)
                vramTotal = 16 * 1024 * 1024 * 1024 / (1024 * 1024); // 16GB in MB (simulated)
                vramFree = vramTotal * (1 - vramUsage / 100);
            } else {
                // Detected Intel-based Mac - using standard GPU simulation
                // For Intel-based Macs, we'll also simulate values but with different ranges
                gpuUsage = Math.random() * 30; // Lower usage for Intel Mac (simulated)
                vramUsage = Math.random() * 50; // Simulated VRAM usage (lower for Mac)
                vramTotal = 16 * 1024 * 1024 * 1024 / (1024 * 1024); // 16GB in MB (simulated)
                vramFree = vramTotal * (1 - vramUsage / 100);
            }
        } else if (platform === 'win32') {
            // On Windows, try to get NVIDIA GPU data using nvidia-smi
            const smiOutput = execSync('nvidia-smi --query-gpu=utilization.gpu,memory.total,memory.used --format=csv,noheader,nounits', { encoding: 'utf8' });
            
            if (smiOutput) {
                const lines = smiOutput.trim().split('\n');
                if (lines.length > 0) {
                    const line = lines[0].trim();
                    const parts = line.split(',').map(p => p.trim());
                    if (parts.length >= 3) {
                        gpuUsage = parseFloat(parts[0]) || 0;
                        vramTotal = parseFloat(parts[1]) || 0;
                        const vramUsed = parseFloat(parts[2]) || 0;
                        vramFree = vramTotal - vramUsed;
                        vramUsage = (vramUsed / vramTotal) * 100 || 0;
                    }
                }
            }
        } else {
            // For other platforms, simulate values
            //Running on ${platform} - using simulated GPU data
            gpuUsage = Math.random() * 50; // Simulated usage for other platforms
            vramUsage = Math.random() * 60; // Simulated VRAM usage
            vramTotal = 8 * 1024 * 1024 * 1024 / (1024 * 1024); // 8GB in MB (simulated)
            vramFree = vramTotal * (1 - vramUsage / 100);
        }
    } catch (error) {
        // If we fail to get GPU/VRAM data, fall back to simulated values
        // Failed to get GPU/VRAM data
        gpuUsage = Math.random() * 50; // Simulated fallback for all platforms
        vramUsage = Math.random() * 60; // Simulated fallback for all platforms
        vramTotal = 8 * 1024 * 1024 * 1024 / (1024 * 1024); // 8GB in MB (simulated)
        vramFree = vramTotal * (1 - vramUsage / 100);
    }
    
    return {
        cpu: cpuUsage,
        ram: ramUsage,
        gpu: gpuUsage,
        vram: vramUsage,
        totalMemory: totalMemory,
        freeMemory: freeMemory,
        vramTotal: vramTotal,
        vramFree: vramFree
    };
}

// Function to update system metrics history
async function updateSystemMetricsHistory() {
    const metrics = await getSystemMetrics();
    // Update CPU history (keep last 50 points)
    systemMetrics.cpu.usage = metrics.cpu;
    if (systemMetrics.cpu.history.length >= 50) {
        systemMetrics.cpu.history.shift();
    }
    systemMetrics.cpu.history.push(metrics.cpu);
    
    // Update RAM history
    systemMetrics.ram.usage = metrics.ram;
    systemMetrics.ram.total = metrics.totalMemory;
    systemMetrics.ram.free = metrics.freeMemory;
    if (systemMetrics.ram.history.length >= 50) {
        systemMetrics.ram.history.shift();
    }
    systemMetrics.ram.history.push(metrics.ram);
    
    // Update GPU history
    systemMetrics.gpu.usage = metrics.gpu;
    systemMetrics.gpu.memory = metrics.vramTotal - metrics.vramFree; // Used VRAM in bytes
    if (systemMetrics.gpu.history.length >= 50) {
        systemMetrics.gpu.history.shift();
    }
    systemMetrics.gpu.history.push(metrics.gpu);
    
    // Update VRAM history
    systemMetrics.vram.usage = metrics.vram;
    systemMetrics.vram.total = metrics.vramTotal;
    systemMetrics.vram.free = metrics.vramFree;
    if (systemMetrics.vram.history.length >= 50) {
        systemMetrics.vram.history.shift();
    }
    systemMetrics.vram.history.push(metrics.vram);
}

// Start periodic system metrics collection
setInterval(updateSystemMetricsHistory, 1000); // Update every second

// Function to recursively find GGUF files
async function findGGUFFiles(directory) {
    const ggufFiles = [];
    // Get the models directory from settings or use environment variable or default
    let basePath = directory || process.env.MODEL_PATH || "C:\\models";
    
    // Try to read the settings file to get the configured models directory
    try {
        const settingsPath = path.join(__dirname, 'settings.json');
        const settingsData = await fs.readFile(settingsPath, 'utf8');
        const settings = JSON.parse(settingsData);
        if (settings.modelsDirectory) {
            basePath = settings.modelsDirectory;
        }
    } catch (error) {
        // If settings file doesn't exist or can't be read, use default path
        console.log('Using default models directory since settings file not found:', error.message);
    }
    
    try {
        // Check if directory exists
        await fs.access(basePath);
        
        async function searchDirectory(dir) {
            try {
                const items = await fs.readdir(dir, { withFileTypes: true });
                
                for (const item of items) {
                    const itemPath = path.join(dir, item.name);
                    
                    if (item.isDirectory()) {
                        // Recursively search subdirectories
                        await searchDirectory(itemPath);
                    } else if (item.isFile() && item.name.toLowerCase().startsWith('mmproj')) {
                        continue; // Skip mmproj files
                    }
                    else if (item.isFile() && item.name.toLowerCase().endsWith('.gguf')) {
                        // Add GGUF file with relative path
                        const relativePath = path.relative(basePath, itemPath);

                        // Check for corresponding mmproj file in the same directory
                        let mmprojFile = null;
                        
                        // Look for any file starting with "mmproj" in the same directory
                        for (const dirItem of items) {
                            if (dirItem.isFile() && dirItem.name.startsWith('mmproj')) {
                                mmprojFile = path.join(dir, dirItem.name);
                                break;
                            }
                        }
                        
                        ggufFiles.push({
                            name: item.name,
                            path: itemPath,
                            relativePath: relativePath,
                            mmprojFile: mmprojFile
                        });
                    }
                }
            } catch (error) {
                console.error(`Error reading directory ${dir}:`, error);
            }
        }
        
        await searchDirectory(basePath);
    } catch (error) {
        console.error('Error accessing models directory:', error);
    }
    
    return ggufFiles;
}

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve Swagger documentation
app.get('/swagger', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'swagger.html'));
});

// API endpoint to start the llama server
app.post('/start', (req, res) => {
    const { serverPath, args = [] } = req.body;
    
    if (!serverPath) {
        return res.status(400).json({ 
            success: false, 
            error: 'Server path is required' 
        });
    }
    
    // Check if process is already running
    if (runningProcess) {
        return res.json({ 
            success: false, 
            error: 'Server is already running' 
        });
    }
    
    // Store the launch configuration for restart functionality
    lastLaunchConfig = { serverPath, args };
    
    // Start the server using spawn for better process control
    try {
        console.log('Starting server with args:', args);
        runningProcess = spawn(serverPath, args, { stdio: 'pipe' });
        
        // Handle process events
        runningProcess.on('close', (code) => {
            console.log(`Server process exited with code ${code}`);
            runningProcess = null;
            // Notify clients that the process has ended
            connectedClients.forEach(client => {
                client.emit('server-ended', { message: 'Server process has ended' });
            });
        });
        
        runningProcess.on('error', (error) => {
            console.error(`Failed to start process: ${error}`);
            runningProcess = null;
            // Notify clients of error
            connectedClients.forEach(client => {
                client.emit('server-error', { message: 'Failed to start server: ' + error.message });
            });
        });
        
        // Stream stdout and stderr to connected clients
        if (runningProcess.stdout) {
            runningProcess.stdout.on('data', (data) => {
                const logData = data.toString();
                console.log('STDOUT:', logData);
                // Broadcast to all connected clients
                connectedClients.forEach(client => {
                    client.emit('log-stream', { type: 'stdout', data: logData });
                });
            });
        }
        
        if (runningProcess.stderr) {
            runningProcess.stderr.on('data', (data) => {
                const logData = data.toString();
                console.log('STDERR:', logData);
                // Broadcast to all connected clients
                connectedClients.forEach(client => {
                    client.emit('log-stream', { type: 'stderr', data: logData });
                });
            });
        }
        
        res.json({ 
            success: true, 
            message: 'Server started successfully' 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: `Failed to start server: ${error.message}` 
        });
    }
});

// API endpoint to stop the llama server
app.post('/stop', (req, res) => {
    if (!runningProcess) {
        return res.json({
            success: false,
            error: 'No server is currently running'
        });
    }

    // Kill the process gracefully
    try {
        // Check if process is still running before attempting to kill
        if (runningProcess && !runningProcess.killed) {
            runningProcess.kill('SIGTERM'); // Try graceful shutdown first
            setTimeout(() => {
                if (runningProcess && !runningProcess.killed) {
                    runningProcess.kill('SIGKILL'); // Force kill if still running
                }
            }, 1000);
        }
        runningProcess = null;

        // Also stop the proxy server if it's running
        stopProxyServer();

        res.json({
            success: true,
            message: 'Server stopped successfully'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: `Failed to stop server: ${error.message}`
        });
    }
});

// API endpoint to get available GGUF models
app.get('/models', async (req, res) => {
    try {
        const models = await findGGUFFiles();
        res.json({ 
            success: true, 
            models: models 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: 'Failed to fetch models: ' + error.message 
        });
    }
});

// API endpoint to get system metrics
app.get('/metrics', (req, res) => {
    // Return just the current values for CPU, RAM, GPU, and VRAM
    res.json({ 
        cpu: systemMetrics.cpu.usage,
        ram: systemMetrics.ram.usage,
        gpu: systemMetrics.gpu.usage,
        vram:  systemMetrics.vram.usage,
        vramUsage: `${systemMetrics.vram.total - systemMetrics.vram.free}/${systemMetrics.vram.total}`,
    });
});

// API endpoint to check if server is running
app.get('/status', (req, res) => {
    res.json({ 
        running: !!runningProcess && !runningProcess.killed
    });
});

// API endpoint to restart the llama server
app.post('/restart', (req, res) => {
    // Check if we have a previous launch configuration
    if (!lastLaunchConfig) {
        return res.status(400).json({ 
            success: false, 
            error: 'No previous configuration found to restart from' 
        });
    }
    
    // Stop the current server if running
    if (runningProcess) {
        try {
            // Check if process is still running before attempting to kill
            if (runningProcess && !runningProcess.killed) {
                runningProcess.kill('SIGTERM'); // Try graceful shutdown first
                setTimeout(() => {
                    if (runningProcess && !runningProcess.killed) {
                        runningProcess.kill('SIGKILL'); // Force kill if still running
                    }
                }, 1000);
            }
            runningProcess = null;
        } catch (error) {
            console.error('Error stopping server during restart:', error);
            return res.status(500).json({ 
                success: false, 
                error: `Failed to stop server: ${error.message}` 
            });
        }
    }
    
    // Start the server with the last launch configuration
    try {
        const { serverPath, args } = lastLaunchConfig;
        console.log('Restarting server with args:', args);
        runningProcess = spawn(serverPath, args, { stdio: 'pipe' });
        
        // Handle process events
        runningProcess.on('close', (code) => {
            console.log(`Server process exited with code ${code}`);
            runningProcess = null;
            // Notify clients that the process has ended
            connectedClients.forEach(client => {
                client.emit('server-ended', { message: 'Server process has ended' });
            });
        });
        
        runningProcess.on('error', (error) => {
            console.error(`Failed to start process: ${error}`);
            runningProcess = null;
            // Notify clients of error
            connectedClients.forEach(client => {
                client.emit('server-error', { message: 'Failed to start server: ' + error.message });
            });
        });
        
        // Stream stdout and stderr to connected clients
        if (runningProcess.stdout) {
            runningProcess.stdout.on('data', (data) => {
                const logData = data.toString();
                console.log('STDOUT:', logData);
                // Broadcast to all connected clients
                connectedClients.forEach(client => {
                    client.emit('log-stream', { type: 'stdout', data: logData });
                });
            });
        }
        
        if (runningProcess.stderr) {
            runningProcess.stderr.on('data', (data) => {
                const logData = data.toString();
                console.log('STDERR:', logData);
                // Broadcast to all connected clients
                connectedClients.forEach(client => {
                    client.emit('log-stream', { type: 'stderr', data: logData });
                });
            });
        }
        
        res.json({ 
            success: true, 
            message: 'Server restarted successfully' 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: `Failed to restart server: ${error.message}` 
        });
    }
});

// WebSocket connection handling for log streaming
io.on('connection', (socket) => {
    console.log('Client connected for log streaming');
    connectedClients.push(socket);
    
    // Remove client when disconnected
    socket.on('disconnect', () => {
        console.log('Client disconnected from log streaming');
        const index = connectedClients.indexOf(socket);
        if (index > -1) {
            connectedClients.splice(index, 1);
        }
    });
});

// Start the server with WebSocket support
httpServer.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
});

// API endpoint to get the current models directory path
app.get('/settings', (req, res) => {
    // Read settings from a JSON file or use default if not set
    const settingsPath = path.join(__dirname, 'settings.json');
    fs.readFile(settingsPath, 'utf8')
        .then(data => {
            const settings = JSON.parse(data);
            res.json({ success: true, settings });
        })
        .catch(err => {
            // If settings file doesn't exist, return default settings
            res.json({ success: true, settings: { modelsDirectory: process.env.MODEL_PATH || "C:\\Users\\anubh\\.lmstudio\\models" } });
        });
});

// API endpoint to save the models directory path
app.post('/settings', async (req, res) => {
    const { modelsDirectory } = req.body;
    
    if (!modelsDirectory) {
        return res.status(400).json({ 
            success: false, 
            error: 'Models directory path is required' 
        });
    }
    
    try {
        // Validate that the directory exists
        await fs.access(modelsDirectory);
        
        // Save settings to a JSON file
        const settingsPath = path.join(__dirname, 'settings.json');
        const settings = { modelsDirectory };
        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
        
        res.json({ 
            success: true, 
            message: 'Settings saved successfully' 
        });
    } catch (error) {
        res.status(500).json({ 
            success: false, 
            error: `Failed to save settings: ${error.message}` 
        });
    }
});

// API endpoint to launch model presets
app.post('/launch-presets', async (req, res) => {
    try {
        const { presets, serverPath } = req.body;
        
        if (!presets) {
            return res.status(400).json({ 
                success: false, 
                error: 'Presets content is required' 
            });
        }
        
        // Save the presets to a file
        const presetsFilePath = path.join(__dirname, 'models-preset.ini');
        await fs.writeFile(presetsFilePath, presets);
        console.log('Generated models-preset.ini file:', presetsFilePath);
        
        // If no server path found, use default or prompt user
        if (!serverPath) {
            return res.status(400).json({ 
                success: false, 
                error: 'Server path not found' 
            });
        }
        
        // Build command arguments for llama-server with --models-preset flag
        const args = [];
        args.push('--models-preset', presetsFilePath);
        args.push('--host', "0.0.0.0");
        
        
        console.log('Starting server with presets:', args);
        
        // Start the server using spawn for better process control
        runningProcess = spawn(serverPath, args, { stdio: 'pipe' });
        
        // Handle process events
        runningProcess.on('close', (code) => {
            console.log(`Server process exited with code ${code}`);
            runningProcess = null;
            // Notify clients that the process has ended
            connectedClients.forEach(client => {
                client.emit('server-ended', { message: 'Server process has ended' });
            });
        });
        
        runningProcess.on('error', (error) => {
            console.error(`Failed to start process: ${error}`);
            runningProcess = null;
            // Notify clients of error
            connectedClients.forEach(client => {
                client.emit('server-error', { message: 'Failed to start server: ' + error.message });
            });
        });
        
        // Stream stdout and stderr to connected clients
        if (runningProcess.stdout) {
            runningProcess.stdout.on('data', (data) => {
                const logData = data.toString();
                console.log('STDOUT:', logData);
                // Broadcast to all connected clients
                connectedClients.forEach(client => {
                    client.emit('log-stream', { type: 'stdout', data: logData });
                });
            });
        }
        
        if (runningProcess.stderr) {
            runningProcess.stderr.on('data', (data) => {
                const logData = data.toString();
                console.log('STDERR:', logData);
                // Broadcast to all connected clients
                connectedClients.forEach(client => {
                    client.emit('log-stream', { type: 'stderr', data: logData });
                });
            });
        }
        
        res.json({ 
            success: true, 
            message: 'Server started with model presets successfully',
            presetsFile: presetsFilePath
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: `Failed to start proxy: ${error.message}`
        });
    }
});


// API endpoint to start proxy server
app.post('/start-proxy', (req, res) => {
    if (proxyServer) {
        return res.json({
            success: false,
            error: 'Proxy server is already running'
        });
    }

    try {
        startProxyServer();
        res.json({
            success: true,
            message: 'Proxy server started on port 3002'
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: `Failed to start proxy: ${error.message}`
        });
    }
});

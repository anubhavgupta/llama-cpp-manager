const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs').promises;
const os = require('os');
const app = express();
const PORT = 3001;

// Middleware
app.use(express.static('public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store the running process
let runningProcess = null;
let connectedClients = [];

// Create WebSocket server for log streaming
const httpServer = require('http').createServer(app);
const io = require('socket.io')(httpServer, {
    cors: {
        origin: "*"
    }
});

// System monitoring variables
let systemMetrics = {
    cpu: { usage: 0, history: [] },
    ram: { usage: 0, total: 0, free: 0, history: [] },
    gpu: { usage: 0, memory: 0, history: [] },
    vram: { usage: 0, total: 0, free: 0, history: [] }
};

// Function to get system metrics
function getSystemMetrics() {
    // CPU Usage (simplified - in a real app you'd use a library like node-os-utils)
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    
    cpus.forEach(cpu => {
        totalIdle += cpu.times.idle;
        totalTick += Object.values(cpu.times).reduce((a, b) => a + b, 0);
    });
    
    const idlePercentage = (totalIdle / cpus.length) / (totalTick / cpus.length) * 100;
    const cpuUsage = 100 - idlePercentage;
    
    // RAM Usage
    const totalMemory = os.totalmem();
    const freeMemory = os.freemem();
    const usedMemory = totalMemory - freeMemory;
    const ramUsage = (usedMemory / totalMemory) * 100;
    
    // For GPU and VRAM, we'll simulate values since node doesn't have native GPU monitoring
    // In a real implementation, you'd use libraries like node-ffi-napi or system-specific tools
    const gpuUsage = Math.random() * 100; // Simulated
    const vramUsage = Math.random() * 100; // Simulated
    const vramTotal = 8 * 1024 * 1024 * 1024; // 8GB in bytes (simulated)
    const vramFree = vramTotal * (1 - vramUsage / 100);
    
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
function updateSystemMetricsHistory() {
    const metrics = getSystemMetrics();
    
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
    const basePath = directory || "C:\\Users\\anubh\\.lmstudio\\models";
    
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
                    } else if (item.isFile() && item.name.toLowerCase().endsWith('.gguf')) {
                        // Add GGUF file with relative path
                        const relativePath = path.relative(basePath, itemPath);
                        ggufFiles.push({
                            name: item.name,
                            path: itemPath,
                            relativePath: relativePath
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
        vram: systemMetrics.vram.usage
    });
});

// API endpoint to check if server is running
app.get('/status', (req, res) => {
    res.json({ 
        running: !!runningProcess && !runningProcess.killed
    });
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

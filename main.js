const { app, BrowserWindow, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

let tray = null;
let mainWindow = null;
let backendProcess = null;

// Start Python backend
function startBackend() {
    const pythonPath = 'python'; // or 'python3' on some systems
    const scriptPath = path.join(__dirname, 'backend', 'server.py');
    
    backendProcess = spawn(pythonPath, [scriptPath]);
    
    backendProcess.stdout.on('data', (data) => {
        console.log(`Backend: ${data}`);
    });
    
    backendProcess.stderr.on('data', (data) => {
        console.error(`Backend Error: ${data}`);
    });
    
    backendProcess.on('close', (code) => {
        console.log(`Backend exited with code ${code}`);
    });
}

// Create tray icon
function createTray() {
    // Create a simple colored icon (16x16)
    const icon = nativeImage.createEmpty();
    tray = new Tray(icon);
    
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Open Dashboard',
            click: () => {
                if (mainWindow) {
                    mainWindow.show();
                } else {
                    createWindow();
                }
            }
        },
        {
            label: 'Quit',
            click: () => {
                app.quit();
            }
        }
    ]);
    
    tray.setToolTip('Starlink Dashboard');
    tray.setContextMenu(contextMenu);
    
    tray.on('click', () => {
        if (mainWindow) {
            mainWindow.show();
        } else {
            createWindow();
        }
    });
    
    // Update tray icon color based on status
    updateTrayIcon('gray');
}

function updateTrayIcon(color) {
    // Create colored icon
    const size = 16;
    const canvas = require('canvas').createCanvas(size, size);
    const ctx = canvas.getContext('2d');
    
    // Draw circle
    ctx.fillStyle = color === 'green' ? '#00C853' : 
                    color === 'red' ? '#D50000' : 
                    color === 'yellow' ? '#FFD600' : '#666666';
    ctx.beginPath();
    ctx.arc(size/2, size/2, size/2 - 2, 0, 2 * Math.PI);
    ctx.fill();
    
    const icon = nativeImage.createFromDataURL(canvas.toDataURL());
    if (tray) {
        tray.setImage(icon);
    }
}

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 600,
        height: 750,
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js')
        },
        title: 'Starlink Dashboard',
        backgroundColor: '#1a1a1a'
    });
    
    mainWindow.loadFile('renderer/index.html');
    
    mainWindow.on('close', (event) => {
        event.preventDefault();
        mainWindow.hide();
    });
    
    // Poll status for tray icon updates
    setInterval(async () => {
        try {
            const response = await fetch('http://127.0.0.1:8000/api/status');
            const data = await response.json();
            
            if (data.online) {
                if (data.obstructed_pct > 5) {
                    updateTrayIcon('yellow');
                } else {
                    updateTrayIcon('green');
                }
            } else {
                updateTrayIcon('red');
            }
            
            tray.setToolTip(`Starlink: ${data.status_text}`);
        } catch (err) {
            updateTrayIcon('red');
            tray.setToolTip('Starlink: Disconnected');
        }
    }, 2000);
}

app.whenReady().then(() => {
    startBackend();
    
    // Wait a bit for backend to start
    setTimeout(() => {
        createTray();
        createWindow();
    }, 2000);
});

app.on('window-all-closed', (e) => {
    e.preventDefault();
});

app.on('before-quit', () => {
    if (backendProcess) {
        backendProcess.kill();
    }
});

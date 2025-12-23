# Starlink Dashboard

A modern desktop application for monitoring your Starlink connection statistics in real-time.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- 📊 **Real-time speed graphs** - Download/Upload throughput visualization
- 📡 **Connection monitoring** - Live status updates every 2 seconds
- 🛰️ **Dish alignment info** - Azimuth, elevation, and tilt angles
- 🌐 **GPS satellite tracking** - Number of satellites visible
- ⚡ **Latency monitoring** - Pop ping latency in milliseconds
- 🌡️ **Obstruction detection** - Visual percentage and warnings
- 🔄 **Auto-start on boot** - Runs automatically when Windows starts
- 🎨 **Dark theme UI** - Easy on the eyes
- 📋 **Real-time logs** - Backend debugging and monitoring
- 🔔 **System tray integration** - Runs quietly in the background

## Screenshots

### Network Dashboard

View real-time download/upload speeds with historical graphs.

### Device Information

Hardware version, software version, GPS stats, and dish alignment.

### Live Logs

Real-time backend logs for debugging and monitoring.

## For End Users

### Requirements

- **Operating System**: Windows 10/11 (64-bit)
- **Python**: 3.7 or later ([Download Python](https://www.python.org/downloads/))
  - ⚠️ **Important**: Check "Add Python to PATH" during installation
- **Network**: Connected to Starlink network (dish accessible at 192.168.100.1)

### Installation

1. **Download** the installer: `Starlink Dashboard Setup 1.0.0.exe`
2. **Run** the installer and follow the wizard
3. **Install Python dependencies** when prompted (or run `setup-python-deps.bat` later)
4. **Launch** the app - it will appear in your system tray

### Usage

- **System Tray Icon**: Color indicates status
  - 🟢 Green = Online
  - 🟡 Yellow = Obstructed
  - 🔴 Red = Offline/Disconnected
- **Open Dashboard**: Right-click tray icon → "Open Dashboard"
- **View Logs**: Click the "LOGS" tab for real-time backend activity
- **Quit**: Right-click tray icon → "Quit"
- **Auto-start**: App launches automatically on Windows startup

### Troubleshooting

If you see "Starlink is disconnected":

1. **Check Python dependencies**:

   - Run `check-dependencies.bat` from the installation folder
   - Or run `setup-python-deps.bat` to install missing packages

2. **Verify Python installation**:

   ```cmd
   python --version
   ```

   Should show Python 3.7 or later

3. **Check Starlink connection**:
   - Ensure you're connected to the Starlink network
   - Try opening http://192.168.100.1 in your browser

For more help, see [TROUBLESHOOTING.md](TROUBLESHOOTING.md)

## For Developers

### Development Setup

1. **Clone the repository**:

   ```bash
   git clone <repository-url>
   cd starlink
   ```

2. **Install Node.js dependencies**:

   ```bash
   npm install
   ```

3. **Install Python dependencies**:

   ```bash
   pip install -r requirements.txt
   ```

4. **Run in development mode**:

   ```bash
   # Terminal 1: Start Python backend
   python backend/server.py

   # Terminal 2: Start Electron app
   npm start
   ```

The app will launch with DevTools open for debugging.

### Building the Installer

**Recommended (with admin privileges)**:

```powershell
.\build-installer-admin.ps1
```

This automatically requests administrator privileges needed for symbolic link creation.

**Alternative (manual admin)**:

```bash
# Right-click → Run as Administrator
.\build-installer.bat
```

**Or using npm directly**:

```bash
npm run dist
```

The installer will be created at: `dist/Starlink Dashboard Setup 1.0.0.exe`

### Distribution

Share the installer file with others. The installer includes:

- ✅ Application files and resources
- ✅ Python backend scripts
- ✅ Setup helper scripts (`setup-python-deps.bat`, `check-dependencies.bat`)
- ✅ Auto-startup registry configuration
- ✅ Desktop and Start Menu shortcuts

### Project Structure

```
starlink/
├── backend/
│   └── server.py              # FastAPI backend server
├── renderer/
│   ├── index.html             # Main UI
│   ├── styles.css             # Styling
│   └── app.js                 # Frontend logic + Chart.js
├── build/
│   ├── installer.nsh          # NSIS installer script
│   ├── setup-python-deps.bat  # Dependency installer
│   └── check-dependencies.bat # Dependency checker
├── main.js                    # Electron main process
├── preload.js                 # Preload script for security
├── package.json               # Node dependencies & build config
├── requirements.txt           # Python dependencies
├── build-installer-admin.ps1  # Installer build script (admin)
├── build-installer.bat        # Installer build script (basic)
└── README.md                  # This file
```

### API Endpoints

The Python backend exposes the following REST API:

- `GET /api/status` - Current Starlink status and statistics
- `GET /api/history` - Speed history for graphing (last 30 data points)
- `GET /api/logs` - Recent backend logs (last 200 entries)
- `GET /health` - Health check endpoint

### Tech Stack

- **Backend**:
  - Python 3.7+
  - FastAPI (REST API framework)
  - starlink-client (gRPC client for Starlink dish)
  - uvicorn (ASGI server)
- **Frontend**:
  - Electron 28 (Desktop app framework)
  - Chart.js 4 (Data visualization)
  - Vanilla JavaScript (No heavy frameworks)
- **Packaging**:
  - electron-builder (Installer creation)
  - NSIS (Windows installer)

### Development Notes

- Backend polls Starlink every 2 seconds
- Frontend updates UI every 2 seconds
- Logs update every 1 second when LOGS tab is active
- Keeps last 200 log messages in memory
- Auto-scrolls logs if user is at bottom

## Contributing

Feel free to submit issues and pull requests!

## License

MIT License - See LICENSE file for details

## Acknowledgments

- [starlink-client](https://github.com/sparky8512/starlink-grpc-tools) - Python gRPC client for Starlink
- Built with ❤️ for Starlink users

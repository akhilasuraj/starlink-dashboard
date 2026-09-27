# Starlink Dashboard

A modern desktop application for monitoring your Starlink connection statistics in real-time.

> Revival in progress: the live monitor distinguishes dish reachability, dish-reported service state, and stale readings. A local SQLite database now retains 15-minute traffic, latency, and loss views across restarts. The installer still needs a separate Python runtime. See [the implementation plan](docs/implementation-plan.md) for the remaining work.

![Platform](https://img.shields.io/badge/platform-Windows-blue)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- 📊 **Current traffic graph** - Observed download/upload traffic, not a speed test
- 📡 **Connection monitoring** - Live status updates every 2 seconds
- 🛰️ **Dish alignment info** - Azimuth and elevation when reported
- 🌐 **GPS reception** - GPS satellite count when reported
- ⚡ **Latency monitoring** - Pop ping latency in milliseconds
- 🌡️ **Obstruction detection** - Visual percentage and warnings
- 🔄 **Auto-start on boot** - Installer-managed startup in the current legacy package
- 🎨 **Dark theme UI** - Easy on the eyes
- 📋 **Real-time logs** - Backend debugging and monitoring
- 🔔 **System tray integration** - Runs quietly in the background

## Screenshots

### Network Dashboard

View current download/upload traffic and a 15-minute observed history. This is not a speed test.

### Device Information

Hardware version, software version, GPS stats, and dish alignment.

### Live Logs

Real-time backend logs for debugging and monitoring.

## For End Users

### Requirements

- **Operating System**: Windows 10/11 (64-bit)
- **Python**: 3.9 or later ([Download Python](https://www.python.org/downloads/))
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
  - 🟡 Yellow = Dish unreachable, stale data, collector issue, or unknown service state
  - 🔴 Red = Dish-reported service offline
- **Open Dashboard**: Right-click tray icon → "Open Dashboard"
- **View Logs**: Click the "LOGS" tab for real-time backend activity
- **Quit**: Right-click tray icon → "Quit"
- **Auto-start**: The current installer configures startup; opt-in behavior is planned

### Troubleshooting

If you see "Starlink is disconnected":

1. **Check Python dependencies**:

   - Run `check-dependencies.bat` from the installation folder
   - Or run `setup-python-deps.bat` to install missing packages

2. **Verify Python installation**:

   ```cmd
   python --version
   ```

   Should show Python 3.9 or later

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

- `GET /api/status` - Collection and service state, freshness, capabilities, and measured values
- `GET /api/history` - Persisted 15-minute traffic, latency, and loss samples, with source, capture time, estimated dish sample time, and uncollected gaps
- `GET /api/logs` - Recent backend logs (last 200 entries)
- `GET /health` - Health check endpoint

### Tech Stack

- **Backend**:
  - Python 3.9+
  - FastAPI (REST API framework)
  - starlink-grpc-core (local gRPC status client for Starlink dish)
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
- Dish history is polled about every 10 seconds when available and stored in SQLite under the user's local app data directory. `STARLINK_DASHBOARD_DATA_DIR` overrides the data directory.
- The dish history call has counters but no UTC timestamps. The API estimates each one-second sample time from the local poll time and labels that estimate separately from `observed_at`.
- Frontend updates UI every 2 seconds
- Logs update every 1 second when LOGS tab is active
- Keeps last 200 log messages in memory
- Auto-scrolls logs if user is at bottom

## Contributing

Feel free to submit issues and pull requests!

## License

MIT License - See LICENSE file for details

## Acknowledgments

- [starlink-grpc-core](https://pypi.org/project/starlink-grpc-core/) - Python gRPC client for Starlink
- Built with ❤️ for Starlink users

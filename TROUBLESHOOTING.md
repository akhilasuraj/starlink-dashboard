# Troubleshooting Guide

## "Starlink is Disconnected" Error

If you see "Starlink is disconnected" after installing, here's what to check:

### 1. **Install Python Dependencies** (Most Common Issue)

After installation, you need to install Python dependencies:

**Option A: During Installation**

- When prompted, click "Yes" to install Python dependencies

**Option B: After Installation**

- Navigate to your installation folder (e.g., `C:\Program Files\Starlink Dashboard\`)
- Run `setup-python-deps.bat`
- Or manually run: `pip install -r resources\requirements.txt`

### 2. **Check Python Installation**

Open Command Prompt and run:

```cmd
python --version
```

You should see Python 3.7 or later. If not:

- Download Python from https://www.python.org/downloads/
- **Important**: Check "Add Python to PATH" during installation
- Restart your computer after installing Python

### 3. **Check Starlink Connection**

- Ensure your computer is connected to the Starlink network
- The Starlink router should be accessible at `192.168.100.1`
- Try opening http://192.168.100.1 in your browser to verify

### 4. **View Backend Logs**

To see what's happening with the Python backend:

1. Close the Starlink Dashboard app
2. Open Command Prompt
3. Navigate to installation folder: `cd "C:\Program Files\Starlink Dashboard\resources\backend"`
4. Run manually: `python server.py`
5. Look for any error messages

Common errors:

- `ModuleNotFoundError`: Python dependencies not installed (see step 1)
- `Connection refused`: Not connected to Starlink network
- `python: command not found`: Python not installed or not in PATH

### 5. **Reinstall the Application**

If all else fails:

1. Uninstall Starlink Dashboard
2. Make sure Python 3.7+ is installed and in PATH
3. Reinstall using the latest installer
4. Say "Yes" when prompted to install Python dependencies

## Quick Test

Open PowerShell and run:

```powershell
python -c "import starlink_client; print('Dependencies OK')"
```

If you see "Dependencies OK", the Python setup is correct.

## Need More Help?

Check the application logs:

- Windows: Press `Ctrl+Shift+I` in the dashboard to open DevTools
- Look at the Console tab for error messages

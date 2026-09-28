"""Build the standalone Windows collector using the pinned build environment."""

from pathlib import Path
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
if sys.platform != "win32":
    raise SystemExit("Build the Windows collector on Windows")
if sys.version_info[:2] != (3, 12):
    raise SystemExit("The pinned collector build uses Python 3.12")

subprocess.run([
    sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
    "--name", "starlink-collector", "--paths", str(ROOT),
    "--distpath", str(ROOT / "build" / "collector-dist"),
    "--workpath", str(ROOT / "build" / "collector-work"),
    "--specpath", str(ROOT / "build" / "collector-spec"),
    "--hidden-import", "uvicorn.lifespan.on",
    "--hidden-import", "uvicorn.loops.asyncio",
    "--hidden-import", "uvicorn.protocols.http.h11_impl",
    "--collect-submodules", "grpc_reflection",
    "--collect-submodules", "yagrc",
    str(ROOT / "backend" / "collector.py"),
], cwd=ROOT, check=True)

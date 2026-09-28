"""Private collector process, owned by one desktop app session."""

import json
import os
import socket

import uvicorn

from backend.server import app


def run():
    token = os.environ.get("STARLINK_DASHBOARD_SESSION_TOKEN", "")
    if len(token) < 32:
        raise SystemExit("Collector requires a private desktop session")
    app.state.session_token = token
    # The OS chooses a free loopback port; keep the socket bound through startup.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        listener.listen(128)
        print(json.dumps({"event": "collector-listening", "port": listener.getsockname()[1]}), flush=True)
        server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", log_level="warning",
                                             loop="asyncio", http="h11", ws="none"))
        server.run(sockets=[listener])


if __name__ == "__main__":
    run()

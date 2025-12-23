from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from contextlib import asynccontextmanager
import asyncio
from collections import deque
from starlink_client.grpc_client import GrpcClient
import spacex.api.device.device_pb2 as device_pb2
from google.protobuf.json_format import MessageToDict
import logging
from datetime import datetime

# Setup logging with custom handler to capture logs
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# Log storage
log_messages = deque(maxlen=200)  # Keep last 200 log messages

class LogCapture(logging.Handler):
    """Custom logging handler to capture logs"""
    def emit(self, record):
        log_entry = {
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "level": record.levelname,
            "message": self.format(record)
        }
        log_messages.append(log_entry)

# Add custom handler to root logger
log_handler = LogCapture()
log_handler.setFormatter(logging.Formatter('%(levelname)s - %(name)s - %(message)s'))
logging.getLogger().addHandler(log_handler)

# Configuration
STARLINK_IP = '192.168.100.1:9200'
POLL_INTERVAL = 2  # seconds
HISTORY_LEN = 30  # 1 minute at 2-second intervals

# Global state
current_stats = {
    "online": False,
    "status_text": "Connecting...",
    "down": 0.0,
    "up": 0.0,
    "ping": 0,
    "obstructed_pct": 0.0,
    "uptime_s": 0,
    "hardware": "--",
    "software": "--",
    "gps_sats": 0,
    "azimuth": 0.0,
    "elevation": 0.0,
    "tilt": 0.0,
    "heater": "--",
    "eth_speed": 0
}

history_down = deque([0] * HISTORY_LEN, maxlen=HISTORY_LEN)
history_up = deque([0] * HISTORY_LEN, maxlen=HISTORY_LEN)

async def poll_starlink():
    """Background task to poll Starlink data"""
    while True:
        try:
            client = GrpcClient(host=STARLINK_IP)
            req = device_pb2.Request(get_status=device_pb2.GetStatusRequest())
            response = client.call(req)
            
            pb_dict = MessageToDict(response, preserving_proto_field_name=True)
            dish_status = pb_dict.get('dish_get_status', {})
            device_state = dish_status.get('device_state', {})
            device_info = dish_status.get('device_info', {})
            obstruction_stats = dish_status.get('obstruction_stats', {})
            gps_stats = dish_status.get('gps_stats', {})
            alignment = dish_status.get('alignment_stats', {})
            config = dish_status.get('config', {})
            
            # Update stats
            down = float(dish_status.get("downlink_throughput_bps", 0)) / 1000000.0
            up = float(dish_status.get("uplink_throughput_bps", 0)) / 1000000.0
            
            current_stats.update({
                "online": True,
                "down": down,
                "up": up,
                "ping": float(dish_status.get("pop_ping_latency_ms", 0)),
                "obstructed_pct": float(obstruction_stats.get("fraction_obstructed", 0.0)) * 100,
                "uptime_s": float(device_state.get("uptime_s", 0)),
                "hardware": device_info.get("hardware_version", "Unknown"),
                "software": device_info.get("software_version", "Unknown"),
                "gps_sats": int(gps_stats.get("gps_sats", 0)),
                "azimuth": float(dish_status.get("boresight_azimuth_deg", 0)),
                "elevation": float(dish_status.get("boresight_elevation_deg", 0)),
                "tilt": float(alignment.get("tilt_angle_deg", 0)),
                "heater": config.get("snow_melt_mode", "UNKNOWN"),
                "eth_speed": int(dish_status.get("eth_speed_mbps", 0))
            })
            
            # Determine status
            if down > 0.0 or current_stats["ping"] > 0:
                if current_stats["obstructed_pct"] > 5.0:
                    current_stats["status_text"] = "Online (Obstructed)"
                else:
                    current_stats["status_text"] = "Online"
            elif current_stats["obstructed_pct"] > 0.0:
                current_stats["status_text"] = "Obstructed"
            else:
                current_stats["status_text"] = "Idle"
            
            # Update history
            history_down.append(down)
            history_up.append(up)
            
            logger.info(f"Polled: {current_stats['status_text']} - {down:.1f}/{up:.1f} Mbps")
            
        except Exception as e:
            logger.error(f"Poll error: {e}")
            current_stats.update({
                "online": False,
                "status_text": "Disconnected"
            })
            history_down.append(0)
            history_up.append(0)
        
        await asyncio.sleep(POLL_INTERVAL)

@asynccontextmanager
async def lifespan(app: FastAPI):
    # Start background task
    task = asyncio.create_task(poll_starlink())
    yield
    # Cleanup
    task.cancel()

app = FastAPI(lifespan=lifespan)

# CORS for Electron
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/api/status")
async def get_status():
    """Get current Starlink status"""
    return current_stats

@app.get("/api/history")
async def get_history():
    """Get speed history for graphing"""
    return {
        "download": list(history_down),
        "upload": list(history_up)
    }

@app.get("/api/logs")
async def get_logs():
    """Get recent backend logs"""
    return {
        "logs": list(log_messages)
    }

@app.get("/health")
async def health():
    """Health check endpoint"""
    return {"status": "ok"}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000, log_level="info")

import threading
import time
import pystray
from PIL import Image, ImageDraw
import customtkinter as ctk
from starlink_client.grpc_client import GrpcClient
import spacex.api.device.device_pb2 as device_pb2
from google.protobuf.json_format import MessageToDict
import logging
from datetime import timedelta
from collections import deque
import numpy as np
from scipy.interpolate import make_interp_spline

# Matplotlib Integration
import matplotlib
matplotlib.use("TkAgg")
from matplotlib.figure import Figure
from matplotlib.backends.backend_tkagg import FigureCanvasTkAgg
import matplotlib.pyplot as plt

# Configure Logging
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

# App Configuration
POLL_INTERVAL = 2 # seconds
STARLINK_IP = '192.168.100.1:9200'
HISTORY_LEN = 30 # 1 mins * 60 secs / 2 sec interval = 30 points

class StarlinkTrayApp:
    def __init__(self):
        # Stats State
        self.stats = {
            "online": False, "status_text": "Connecting...",
            "down": 0.0, "up": 0.0, "ping": 0,
            "obstructed_pct": 0.0, "valid_s": 0,
            "uptime_s": 0,
            "hardware": "--", "software": "--", "country": "--",
            "gps_valid": False, "sats": 0,
            "azimuth": 0.0, "elevation": 0.0, "tilt": 0.0, "snr_good": False,
            "heater": "--", "eth_speed": 0
        }
        
        # History for Graph
        self.history_down = deque([0]*HISTORY_LEN, maxlen=HISTORY_LEN)
        self.history_up = deque([0]*HISTORY_LEN, maxlen=HISTORY_LEN)
        
        self.running = True
        self.window = None
        self.ax = None
        self.canvas = None
        self.line_down = None
        self.line_up = None
        
        # Start Polling Thread
        self.poll_thread = threading.Thread(target=self.poll_loop, daemon=True)
        self.poll_thread.start()
        
        # Setup Tray
        self.icon = pystray.Icon("StarlinkStats")
        self.icon.menu = pystray.Menu(
            pystray.MenuItem(lambda item: self.stats["status_text"], None, enabled=False),
            pystray.MenuItem("Open Dashboard", self.show_dashboard),
            pystray.MenuItem("Exit", self.exit_app)
        )
        self.icon.icon = self.create_image("gray")
        self.icon.title = "Starlink Stats: Connecting..."

    def create_image(self, color):
        width = 64
        height = 64
        image = Image.new('RGB', (width, height), (255, 255, 255))
        dc = ImageDraw.Draw(image)
        dc.rectangle((0, 0, width, height), fill=(20, 20, 20))
        
        dot_color = {
            "green": (0, 200, 83),
            "red": (213, 0, 0),
            "yellow": (255, 214, 0),
            "gray": (100, 100, 100)
        }.get(color, (100, 100, 100))
        
        dc.ellipse((14, 14, 50, 50), outline=dot_color, width=5)
        dc.ellipse((26, 26, 38, 38), fill=dot_color)
        return image

    def poll_loop(self):
        while self.running:
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
                
                # Parsing
                bs_down = float(dish_status.get("downlink_throughput_bps", 0)) / 1000000.0
                bs_up = float(dish_status.get("uplink_throughput_bps", 0)) / 1000000.0
                
                self.stats["down"] = bs_down
                self.stats["up"] = bs_up
                self.stats["ping"] = float(dish_status.get("pop_ping_latency_ms", 0))
                self.stats["obstructed_pct"] = float(obstruction_stats.get("fraction_obstructed", 0.0)) * 100
                self.stats["valid_s"] = float(obstruction_stats.get("valid_s", 0))
                self.stats["uptime_s"] = float(device_state.get("uptime_s", 0))
                self.stats["hardware"] = device_info.get("hardware_version", "Unknown")
                self.stats["software"] = device_info.get("software_version", "Unknown")
                self.stats["country"] = device_info.get("country_code", "--")
                self.stats["gps_valid"] = gps_stats.get("gps_valid", False)
                self.stats["sats"] = int(gps_stats.get("gps_sats", 0))
                self.stats["azimuth"] = float(dish_status.get("boresight_azimuth_deg", 0))
                self.stats["elevation"] = float(dish_status.get("boresight_elevation_deg", 0))
                self.stats["tilt"] = float(alignment.get("tilt_angle_deg", 0))
                self.stats["snr_good"] = dish_status.get("is_snr_above_noise_floor", False)
                self.stats["heater"] = config.get("snow_melt_mode", "UNKNOWN")
                self.stats["eth_speed"] = int(dish_status.get("eth_speed_mbps", 0))
                
                # Update Graphs History
                self.history_down.append(bs_down)
                self.history_up.append(bs_up)
                
                # Logic
                self.stats["online"] = True
                
                if self.stats["down"] > 0.0 or self.stats["ping"] > 0:
                     color = "green"
                     if self.stats["obstructed_pct"] > 5.0:
                         self.stats["status_text"] = "Online (Obstructed)"
                         color = "yellow"
                     else:
                         self.stats["status_text"] = f"Online: {self.stats['down']:.1f} Mbps"
                elif self.stats["obstructed_pct"] > 0.0:
                    color = "yellow"
                    self.stats["status_text"] = "Obstructed"
                else:
                    color = "green"
                    self.stats["status_text"] = "Idle"
                    
            except Exception as e:
                self.stats["online"] = False
                color = "red"
                self.stats["status_text"] = "Disconnected"
                # Keep graph flat on disconnect
                self.history_down.append(0)
                self.history_up.append(0)
            
            if self.icon:
                self.icon.icon = self.create_image(color)
                title = f"Starlink: {self.stats['status_text']}"
                if len(title) > 63: title = title[:60] + "..."
                self.icon.title = title

            if self.window and self.window.winfo_exists():
                self.window.after(0, self.update_dashboard)
                
            time.sleep(POLL_INTERVAL)

    def show_dashboard(self, icon=None, item=None):
        if self.window is None or not self.window.winfo_exists():
            self.create_window()
        else:
            self.window.lift()
            self.window.focus_force()

    def create_window(self):
        ctk.set_appearance_mode("Dark")
        ctk.set_default_color_theme("blue")
        
        self.window = ctk.CTk()
        self.window.title("STARLINK DASHBOARD")
        self.window.geometry("600x750")

        # --- 1. Global Header ---
        self.fr_header = ctk.CTkFrame(self.window, fg_color="transparent")
        self.fr_header.pack(fill="x", padx=10, pady=(20, 10))
        
        self.lbl_big_status = ctk.CTkLabel(self.fr_header, text="--", font=("Arial", 28, "bold"))
        self.lbl_big_status.pack()
        self.lbl_uptime = ctk.CTkLabel(self.fr_header, text="Uptime: --", font=("Arial", 12), text_color="gray")
        self.lbl_uptime.pack()

        # --- 2. Tabview ---
        self.tabs = ctk.CTkTabview(self.window)
        self.tabs.pack(fill="both", expand=True, padx=10, pady=(0, 10))
        
        # Create Tabs
        self.tab_net = self.tabs.add("NETWORK")
        self.tab_vis = self.tabs.add("VISIBILITY")
        self.tab_dev = self.tabs.add("DEVICE")

        # --- Network Tab ---
        self.tab_net.grid_columnconfigure((0,1), weight=1)
        
        self.create_stat_card(self.tab_net, "DOWNLOAD", "lbl_down", 0, 0, "Mbps")
        self.create_stat_card(self.tab_net, "UPLOAD", "lbl_up", 0, 1, "Mbps")
        # Ping
        f_ping = ctk.CTkFrame(self.tab_net)
        f_ping.grid(row=1, column=0, columnspan=2, padx=5, pady=5, sticky="nsew")
        ctk.CTkLabel(f_ping, text="LATENCY", font=("Arial", 11, "bold"), text_color="gray").pack(pady=(10,2))
        self.lbl_ping = ctk.CTkLabel(f_ping, text="--", font=("Arial", 22, "bold"))
        self.lbl_ping.pack()
        ctk.CTkLabel(f_ping, text="ms", font=("Arial", 10), text_color="gray").pack(pady=(0,10))

        # Graph Container
        self.fr_graph = ctk.CTkFrame(self.tab_net, fg_color="#1a1a1a") # specific dark bg
        self.fr_graph.grid(row=2, column=0, columnspan=2, padx=5, pady=10, sticky="nsew")
        self.tab_net.grid_rowconfigure(2, weight=1)
        
        # Matplotlib Setup
        self.init_graph(self.fr_graph)

        # --- Visibility Tab ---
        self.lbl_obstructed = ctk.CTkLabel(self.tab_vis, text="Obstructed: 0%", font=("Arial", 16))
        self.lbl_obstructed.pack(pady=20)
        self.progress_obs = ctk.CTkProgressBar(self.tab_vis, height=20)
        self.progress_obs.set(0)
        self.progress_obs.pack(fill="x", padx=40, pady=(0, 20))
        
        # --- Device Tab ---
        self.tab_dev.grid_columnconfigure(0, weight=1)
        self.tab_dev.grid_columnconfigure(1, weight=1)
        
        self.create_section_label(self.tab_dev, "DETAILS", 0)
        self.create_detail_row(self.tab_dev, 1, "Hardware", "lbl_hw")
        self.create_detail_row(self.tab_dev, 2, "Software", "lbl_sw")
        self.create_detail_row(self.tab_dev, 3, "GPS Sats", "lbl_sats")
        self.create_detail_row(self.tab_dev, 4, "Eth Speed", "lbl_eth")
        self.create_detail_row(self.tab_dev, 5, "Heater", "lbl_heater")
        
        self.create_section_label(self.tab_dev, "ALIGNMENT", 6)
        self.create_detail_row(self.tab_dev, 7, "Azimuth", "lbl_azi")
        self.create_detail_row(self.tab_dev, 8, "Elevation", "lbl_ele")
        self.create_detail_row(self.tab_dev, 9, "Tilt", "lbl_tilt")

        self.update_dashboard()
        self.window.protocol("WM_DELETE_WINDOW", self.hide_window)
        self.window.mainloop()

    def init_graph(self, parent_frame):
        # Create Figure
        fig = Figure(figsize=(5, 3), dpi=80, facecolor='#1a1a1a')
        # Add bottom margin for legend
        fig.subplots_adjust(bottom=0.2)
        
        self.ax = fig.add_subplot(111)
        self.ax.set_facecolor('#1a1a1a')
        
        # Hide standard axes clutter
        self.ax.spines['top'].set_visible(False)
        self.ax.spines['right'].set_visible(False)
        self.ax.spines['left'].set_visible(False)
        self.ax.spines['bottom'].set_visible(False)
        self.ax.tick_params(axis='x', colors='gray', labelsize=8)
        self.ax.tick_params(axis='y', colors='gray', labelsize=8)
        
        # Initial empty plot
        x_data = list(range(HISTORY_LEN))
        # Use fill_between for area chart
        self.poly_down = self.ax.fill_between(x_data, 0, 0, color='#FFD700', alpha=0.6, label='Down')
        self.poly_up = self.ax.fill_between(x_data, 0, 0, color='#D50000', alpha=0.6, label='Up')
        
        # Text label (legend-ish) - REMOVED per user request for clean graph
        # self.ax.text(..., 'DOWNLOAD', ...)

        self.canvas = FigureCanvasTkAgg(fig, master=parent_frame)
        self.canvas.draw()
        self.canvas.get_tk_widget().pack(fill="both", expand=True)

    def create_stat_card(self, parent, title, attr_name, row, col, unit):
        f = ctk.CTkFrame(parent)
        f.grid(row=row, column=col, padx=5, pady=5, sticky="nsew")
        ctk.CTkLabel(f, text=title, font=("Arial", 11, "bold"), text_color="gray").pack(pady=(10,2))
        lbl = ctk.CTkLabel(f, text="--", font=("Arial", 22, "bold"))
        lbl.pack()
        ctk.CTkLabel(f, text=unit, font=("Arial", 10), text_color="gray").pack(pady=(0,10))
        setattr(self, attr_name, lbl)

    def create_section_label(self, parent, text, row):
        lbl = ctk.CTkLabel(parent, text=text, font=("Arial", 14, "bold"), text_color="gray")
        lbl.grid(row=row, column=0, columnspan=2, padx=10, pady=(20, 5), sticky="w")

    def create_detail_row(self, parent, row, label, attr_name):
        ctk.CTkLabel(parent, text=label, anchor="w").grid(row=row, column=0, padx=20, pady=5, sticky="w")
        val = ctk.CTkLabel(parent, text="--", anchor="e", font=("Arial", 12, "bold"))
        val.grid(row=row, column=1, padx=20, pady=5, sticky="e")
        setattr(self, attr_name, val)

    def update_dashboard(self):
        try:
            # Header logic (same as before)
            if self.stats["online"]:
                st_text = self.stats["status_text"].split(":")[-1].strip() if ":" in self.stats["status_text"] else self.stats["status_text"]
                self.lbl_big_status.configure(text=st_text)
                color = "#00C853" if "Online" in self.stats["status_text"] else "#D50000"
                if "Obstructed" in self.stats["status_text"]: color = "#FFAB00"
                self.lbl_big_status.configure(text_color=color)
            else:
                self.lbl_big_status.configure(text="DISCONNECTED", text_color="#D50000")
            
            uptime = str(timedelta(seconds=int(self.stats["uptime_s"])))
            self.lbl_uptime.configure(text=f"Uptime: {uptime}")

            # Network
            self.lbl_down.configure(text=f"{self.stats['down']:.1f}")
            self.lbl_up.configure(text=f"{self.stats['up']:.1f}")
            self.lbl_ping.configure(text=f"{self.stats['ping']:.0f}")

            # Graph Update
            if self.ax and self.canvas:
                self.ax.clear()
                # Re-setup styling (clearing removes everything)
                self.ax.spines['top'].set_visible(False)
                self.ax.spines['right'].set_visible(False)
                self.ax.spines['left'].set_visible(False)
                self.ax.spines['bottom'].set_visible(False)
                self.ax.tick_params(axis='x', colors='gray', labelsize=8)
                self.ax.tick_params(axis='y', colors='gray', labelsize=8)
                self.ax.set_xticks([]) # Hide x ticks for cleanliness
                
                # Create smooth X axis
                x = np.array(range(len(self.history_down)))
                y_down = np.array(self.history_down)
                y_up = np.array(self.history_up)
                
                # Interpolate (Spline) - only if we have enough points
                if len(x) > 3:
                     x_smooth = np.linspace(x.min(), x.max(), 300) 
                     spl_down = make_interp_spline(x, y_down, k=3)
                     y_down_smooth = spl_down(x_smooth)
                     
                     spl_up = make_interp_spline(x, y_up, k=3)
                     y_up_smooth = spl_up(x_smooth)
                     
                     # Clip negative overshoots from spline
                     y_down_smooth = np.clip(y_down_smooth, 0, None)
                     y_up_smooth = np.clip(y_up_smooth, 0, None)
                else:
                     x_smooth = x
                     y_down_smooth = y_down
                     y_up_smooth = y_up

                # Plot Down (Yellow Area)
                self.ax.fill_between(x_smooth, y_down_smooth, color='#FFD700', alpha=0.5, label='Download')
                # Plot Up (Red Area)
                self.ax.fill_between(x_smooth, y_up_smooth, color='#D50000', alpha=0.5, label='Upload')
                
                # Dynamic Y Limits
                max_y = max(np.max(y_down_smooth), np.max(y_up_smooth), 5.0) * 1.1
                self.ax.set_ylim(0, max_y)

                
                # Legend at bottom outside graph
                leg = self.ax.legend(loc='upper center', bbox_to_anchor=(0.5, -0.05), ncol=2, frameon=False, fontsize=8)
                for text in leg.get_texts():
                    text.set_color("gray")
                
                self.canvas.draw()

            # Visibility
            pct = self.stats["obstructed_pct"]
            self.lbl_obstructed.configure(text=f"Obstructed: {pct:.2f}%")
            self.progress_obs.set(pct / 100.0)
            if pct > 1: self.progress_obs.configure(progress_color="#FFAB00")
            else: self.progress_obs.configure(progress_color="#00C853")

            # Device
            self.lbl_hw.configure(text=self.stats["hardware"])
            self.lbl_sw.configure(text=self.stats["software"].split("-")[0])
            self.lbl_sats.configure(text=str(self.stats["sats"]))
            self.lbl_eth.configure(text=f"{self.stats['eth_speed']} Mbps")
            self.lbl_heater.configure(text=self.stats["heater"])
            
            self.lbl_azi.configure(text=f"{self.stats['azimuth']:.1f}°")
            self.lbl_ele.configure(text=f"{self.stats['elevation']:.1f}°")
            self.lbl_tilt.configure(text=f"{self.stats['tilt']:.1f}°")

        except Exception:
            pass

    def hide_window(self):
        self.window.destroy()
        # Matplotlib cleanup might be needed? Usually separate process, but here thread issues possible.
        # self.window = None

    def exit_app(self, icon, item):
        self.running = False
        self.icon.stop()
        if self.window:
            self.window.quit()

    def run(self):
        self.icon.run()

if __name__ == "__main__":
    app = StarlinkTrayApp()
    app.run()

const API_URL = "http://127.0.0.1:8000";

// Chart.js setup
let speedChart = null;
let currentTab = "network";
let autoScrollLogs = true;

function initChart() {
  const ctx = document.getElementById("speedChart").getContext("2d");

  speedChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: Array(30).fill(""),
      datasets: [
        {
          label: "Download",
          data: Array(30).fill(0),
          borderColor: "transparent",
          borderWidth: 0,
          backgroundColor: "rgba(255, 215, 0, 0.3)",
          fill: true,
          tension: 0.4,
          pointRadius: 0,
        },
        {
          label: "Upload",
          data: Array(30).fill(0),
          borderColor: "transparent",
          borderWidth: 0,
          backgroundColor: "rgba(213, 0, 0, 0.3)",
          fill: true,
          tension: 0.4,
          pointRadius: 0,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      plugins: {
        legend: {
          display: true,
          position: "bottom",
          labels: {
            color: "#888",
            font: { size: 10 },
            usePointStyle: true,
            pointStyle: "circle",
            boxWidth: 6,
            boxHeight: 6,
          },
        },
      },
      scales: {
        x: {
          display: false,
        },
        y: {
          beginAtZero: true,
          ticks: {
            color: "#888",
            font: { size: 10 },
          },
          grid: {
            color: "#2a2a2a",
          },
        },
      },
    },
  });
}

// Tab switching
document.querySelectorAll(".tab-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const tabName = btn.dataset.tab;
    currentTab = tabName;

    // Update buttons
    document
      .querySelectorAll(".tab-btn")
      .forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");

    // Update panes
    document
      .querySelectorAll(".tab-pane")
      .forEach((pane) => pane.classList.remove("active"));
    document.getElementById(tabName).classList.add("active");

    // Immediately update logs when switching to logs tab
    if (tabName === "logs") {
      updateLogs();
    }
  });
});

// Format uptime
function formatUptime(seconds) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);

  if (days > 0) return `${days}d ${hours}h ${mins}m`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

// Update UI
async function updateData() {
  try {
    const [statusRes, historyRes] = await Promise.all([
      fetch(`${API_URL}/api/status`),
      fetch(`${API_URL}/api/history`),
    ]);

    const status = await statusRes.json();
    const history = await historyRes.json();

    // Header
    document.getElementById("status").textContent =
      status.status_text.toUpperCase();
    document.getElementById("status").style.color = status.status_text.includes(
      "Online"
    )
      ? "#00C853"
      : status.status_text.includes("Obstructed")
      ? "#FFD600"
      : "#D50000";

    document.getElementById("uptime").textContent = `Uptime: ${formatUptime(
      status.uptime_s
    )}`;

    // Network stats
    document.getElementById("upload").textContent = status.up.toFixed(1);
    document.getElementById("download").textContent = status.down.toFixed(1);
    document.getElementById("latency").textContent = Math.round(status.ping);

    // Update chart
    if (speedChart) {
      speedChart.data.datasets[0].data = history.download;
      speedChart.data.datasets[1].data = history.upload;
      speedChart.update();
    }

    // Visibility
    const obsPct = status.obstructed_pct;
    document.getElementById(
      "obstruction-text"
    ).textContent = `Obstructed: ${obsPct.toFixed(2)}%`;
    const obsBar = document.getElementById("obstruction-bar");
    obsBar.style.width = `${Math.min(obsPct, 100)}%`;
    obsBar.style.background = obsPct > 1 ? "#FFD600" : "#00C853";

    // Device
    document.getElementById("hardware").textContent = status.hardware;
    document.getElementById("software").textContent =
      status.software.split("-")[0];
    document.getElementById("gps-sats").textContent = status.gps_sats;
    document.getElementById(
      "eth-speed"
    ).textContent = `${status.eth_speed} Mbps`;
    document.getElementById("heater").textContent = status.heater;
    document.getElementById("azimuth").textContent = `${status.azimuth.toFixed(
      1
    )}°`;
    document.getElementById(
      "elevation"
    ).textContent = `${status.elevation.toFixed(1)}°`;
    document.getElementById("tilt").textContent = `${status.tilt.toFixed(1)}°`;
  } catch (err) {
    console.error("Update error:", err);
    document.getElementById("status").textContent = "DISCONNECTED";
    document.getElementById("status").style.color = "#D50000";
  }
}

async function updateLogs() {
  if (currentTab !== "logs") return; // Only fetch logs when logs tab is active

  try {
    const response = await fetch(`${API_URL}/api/logs`);
    const data = await response.json();

    const logsContent = document.getElementById("logs-content");
    const wasScrolledToBottom =
      logsContent.scrollHeight - logsContent.clientHeight <=
      logsContent.scrollTop + 50;

    // Build logs HTML
    const logsHTML = data.logs
      .map((log) => {
        const levelClass = `log-${log.level.toLowerCase()}`;
        return `
                <div class="log-entry">
                    <span class="log-time">${log.timestamp.split(" ")[1]}</span>
                    <span class="log-level ${levelClass}">${log.level}</span>
                    <span class="log-message">${escapeHtml(log.message)}</span>
                </div>
            `;
      })
      .join("");

    logsContent.innerHTML =
      logsHTML ||
      '<div class="log-entry"><span class="log-message">No logs available</span></div>';

    // Auto-scroll to bottom if user was at bottom
    if (wasScrolledToBottom && autoScrollLogs) {
      logsContent.scrollTop = logsContent.scrollHeight;
    }
  } catch (err) {
    console.error("Logs fetch error:", err);
  }
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Initialize
document.addEventListener("DOMContentLoaded", () => {
  initChart();
  updateData();
  setInterval(updateData, 2000);
  setInterval(updateLogs, 1000); // Update logs every second

  // Clear logs button
  document.getElementById("clear-logs").addEventListener("click", async () => {
    try {
      await fetch(`${API_URL}/api/logs/clear`, { method: "POST" });
      const logsContent = document.getElementById("logs-content");
      logsContent.innerHTML =
        '<div class="log-entry"><span class="log-message">Logs cleared</span></div>';
    } catch (err) {
      console.error("Failed to clear logs:", err);
    }
  });

  // Detect manual scroll to disable auto-scroll
  document.getElementById("logs-content").addEventListener("scroll", (e) => {
    const element = e.target;
    const isAtBottom =
      element.scrollHeight - element.clientHeight <= element.scrollTop + 50;
    autoScrollLogs = isAtBottom;
  });
});

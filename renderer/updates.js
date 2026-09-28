let updateState = null;
let updateRequestPending = false;

function updateText(id, value) {
  const element = document.getElementById(id);
  if (element.textContent !== value) element.textContent = value;
}

function renderUpdateState(state) {
  updateState = state;
  updateText("app-version", `Version ${state.currentVersion}`);
  updateText("update-message", state.message);
  const busy = updateRequestPending || ["checking", "downloading", "installing"].includes(state.phase);
  document.getElementById("update-check").disabled = !state.supported || busy || state.phase === "downloaded";
  document.getElementById("update-policy").hidden = !state.supported;
  const downloading = state.phase === "downloading";
  const progress = document.getElementById("update-progress");
  progress.hidden = !downloading;
  progress.value = Number.isFinite(state.percent) ? state.percent : 0;
  const action = state.phase === "available" ? "Download update" : state.phase === "downloaded" ? "Restart and install" : null;
  for (const id of ["update-action", "update-notice-action"]) {
    const button = document.getElementById(id);
    button.hidden = !action;
    button.disabled = busy;
    if (action) updateText(id, action);
  }
  document.getElementById("update-notice").hidden = !["available", "downloading", "downloaded", "installing"].includes(state.phase);
  updateText("update-notice-message", state.message);
}

async function requestUpdateAction(action) {
  if (!window.desktopUpdates || updateRequestPending) return;
  updateRequestPending = true;
  if (updateState) renderUpdateState(updateState);
  try {
    const state = await window.desktopUpdates[action]();
    updateRequestPending = false;
    renderUpdateState(state);
  } catch {
    updateRequestPending = false;
    if (updateState) renderUpdateState({ ...updateState, phase: "error", message: "Could not request the update. Try again." });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const bridge = window.desktopUpdates;
  if (!bridge) return;
  document.getElementById("update-check").addEventListener("click", () => requestUpdateAction("check"));
  for (const id of ["update-action", "update-notice-action"]) {
    document.getElementById(id).addEventListener("click", () => {
      const action = updateState?.phase === "available" ? "download" : updateState?.phase === "downloaded" ? "install" : null;
      if (action) return requestUpdateAction(action);
    });
  }
  let reading = false;
  async function refreshUpdates() {
    if (reading) return;
    reading = true;
    try { renderUpdateState(await bridge.getState()); } catch { /* App may be restarting. */ }
    finally { reading = false; }
  }
  refreshUpdates();
  setInterval(refreshUpdates, 2000);
});

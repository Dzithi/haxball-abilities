(() => {
  const WS_URL = "ws://localhost:4200";
  const DEFAULTS = { slot1: "1", slot2: "2", slot3: "3" };

  let ws = null;
  let playerName = null;
  let bindings = {}; // key → slot number

  function loadBindings() {
    chrome.storage.local.get(DEFAULTS, (cfg) => {
      bindings = {};
      bindings[cfg.slot1] = 1;
      bindings[cfg.slot2] = 2;
      bindings[cfg.slot3] = 3;
    });
  }

  loadBindings();
  chrome.storage.onChanged.addListener(loadBindings);

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => console.log("[HaxAbility] Connected to server");
    ws.onclose = () => setTimeout(connect, 3000);
    ws.onerror = () => {};
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  setInterval(() => {
    if (!playerName) {
      try { playerName = localStorage.getItem("player_name"); } catch(e) {}
      if (playerName) send({ type: "identify", name: playerName });
    }
  }, 2000);

  window.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    const slot = bindings[key];
    if (!slot || e.repeat) return;
    send({ type: "keydown", slot, name: playerName });
  }, true);

  window.addEventListener("keyup", (e) => {
    const key = e.key.toLowerCase();
    const slot = bindings[key];
    if (!slot) return;
    send({ type: "keyup", slot, name: playerName });
  }, true);

  connect();
  console.log("[HaxAbility] Extension loaded.");
})();

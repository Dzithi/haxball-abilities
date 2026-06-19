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
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "hud") renderHud(data.slots);
      } catch(e) {}
    };
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
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
    const key = e.key.toLowerCase();
    const slot = bindings[key];
    if (!slot || e.repeat) return;
    send({ type: "keydown", slot, name: playerName });
  }, true);

  window.addEventListener("keyup", (e) => {
    if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable) return;
    const key = e.key.toLowerCase();
    const slot = bindings[key];
    if (!slot) return;
    send({ type: "keyup", slot, name: playerName });
  }, true);

  // --- HUD Overlay ---
  const hud = document.createElement("div");
  hud.id = "hax-ability-hud";
  hud.style.cssText = "position:fixed;bottom:10px;left:10px;background:rgba(0,0,0,0.7);color:#fff;font-family:monospace;font-size:12px;padding:8px 12px;border-radius:6px;z-index:99999;pointer-events:none;line-height:1.6;display:none;";
  document.body.appendChild(hud);

  function renderHud(slots) {
    if (!slots || slots.length < 3) { hud.style.display = "none"; return; }
    hud.style.display = "block";
    const keys = Object.entries(bindings).reduce((m, [k, v]) => { m[v] = k.toUpperCase(); return m; }, {});
    let html = "";
    const s1 = slots[0];
    const cd1 = s1.cd > 0 ? `<span style="color:#ff6666">${s1.cd}s</span>` : `<span style="color:#66ff66">READY</span>`;
    html += `[${keys[1] || "1"}] ${s1.name} ${cd1}<br>`;
    const s2 = slots[1];
    const cd2 = s2.cd > 0 ? `<span style="color:#ff6666">${s2.cd}s</span>` : `<span style="color:#66ff66">READY</span>`;
    html += `[${keys[2] || "2"}] ${s2.name} ${cd2}<br>`;
    const s3 = slots[2];
    const charge = s3.charge || 0;
    const bar = "█".repeat(Math.floor(charge / 10)) + "░".repeat(10 - Math.floor(charge / 10));
    const ultColor = charge >= 100 ? "#ffff00" : "#aaaaaa";
    const ultLabel = charge >= 100 ? "⚡ READY" : `${charge}%`;
    html += `[${keys[3] || "3"}] ${s3.name} <span style="color:${ultColor}">${bar} ${ultLabel}</span>`;
    hud.innerHTML = html;
  }

  connect();
  console.log("[HaxAbility] Extension loaded.");
})();

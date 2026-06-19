(() => {
  const DEFAULTS = { slot1: "1", slot2: "2", slot3: "3" };
  let bindings = {}; // key → slot number

  function loadBindings() {
    browser.storage.local.get(DEFAULTS).then((cfg) => {
      bindings = {};
      bindings[cfg.slot1] = 1;
      bindings[cfg.slot2] = 2;
      bindings[cfg.slot3] = 3;
    });
  }

  loadBindings();
  browser.storage.onChanged.addListener(loadBindings);

  function send(data) {
    try { browser.runtime.sendMessage(data); } catch(e) {}
  }

  let playerName = null;
  function findName() {
    try { playerName = localStorage.getItem("player_name"); } catch(e) {}
    if (playerName) send({ type: "identify", name: playerName });
  }
  setInterval(findName, 2000);
  findName();

  document.addEventListener("keydown", (e) => {
    const key = e.key.toLowerCase();
    const slot = bindings[key];
    if (!slot) return;
    if (e.repeat) return;
    send({ type: "keydown", slot, name: playerName });
  }, true);

  document.addEventListener("keyup", (e) => {
    const key = e.key.toLowerCase();
    const slot = bindings[key];
    if (!slot) return;
    send({ type: "keyup", slot, name: playerName });
  }, true);

  console.log("[HaxAbility] Loaded on:", window.location.href);
})();

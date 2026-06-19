console.log("[HaxAbility BG] Background script starting...");
const WS_URL = "ws://127.0.0.1:4200";
let ws = null;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => console.log("[HaxAbility BG] Connected");
  ws.onclose = () => setTimeout(connect, 3000);
  ws.onerror = () => {};
}

browser.runtime.onMessage.addListener((msg) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
});

connect();

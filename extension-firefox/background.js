console.log("[HaxAbility BG] Background script starting...");
const WS_URL = "ws://127.0.0.1:4200";
let ws = null;

function connect() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => console.log("[HaxAbility BG] Connected");
  ws.onclose = () => setTimeout(connect, 3000);
  ws.onerror = () => {};
  ws.onmessage = (event) => {
    // Forward server messages to content script
    try {
      const data = JSON.parse(event.data);
      browser.tabs.query({ url: ["*://www.haxball.com/*", "*://html5.haxball.com/*"] }).then((tabs) => {
        for (const tab of tabs) {
          browser.tabs.sendMessage(tab.id, data).catch(() => {});
        }
      });
    } catch(e) {}
  };
}

browser.runtime.onMessage.addListener((msg) => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
});

connect();

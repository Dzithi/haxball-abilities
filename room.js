const puppeteer = require("puppeteer");
const fs = require("fs");
const db = require("./db");
const i18n = require("./i18n");
const { WebSocketServer } = require("ws");

process.on("uncaughtException", (e) => console.log("[CRASH PREVENTED]", e.message));
process.on("unhandledRejection", (e) => console.log("[REJECTION]", e));

const TOKEN = process.argv[2];
if (!TOKEN) {
  console.error("Usage: node room.js <token>");
  process.exit(1);
}

const stadiums = {
  training: fs.readFileSync(__dirname + "/stadiums/futsal-training.hbs", "utf8"),
  x1: fs.readFileSync(__dirname + "/stadiums/futsal-x1.hbs", "utf8"),
  x3: fs.readFileSync(__dirname + "/stadiums/futsal-x3.hbs", "utf8"),
};

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",
      "--no-first-run",
      "--no-zygote",
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
    ],
  });

  const page = await browser.newPage();
  page.on("console", (msg) => {
    if (msg.type() === "log") console.log("[HB]", msg.text());
  });

  await page.goto("https://html5.haxball.com/headless", { waitUntil: "networkidle2" });

  // Expose persistence AFTER page loads to avoid Haxball picking them up
  await page.exposeFunction("dbGetPlayer", (auth) => db.getPlayer(auth));
  await page.exposeFunction("dbSavePlayer", (auth, data) => db.savePlayer(auth, data));
  await page.exposeFunction("dbGetAllPlayers", () => db.getAllPlayers());
  await page.exposeFunction("dbLogMatch", (match) => db.logMatch(match));
  await page.exposeFunction("dbGetBans", () => db.getBans());
  await page.exposeFunction("dbAddBan", (entry) => db.addBan(entry));
  await page.exposeFunction("dbClearBans", () => db.clearBans());
  await page.exposeFunction("dbSaveFeedback", (entry) => {
    const fs = require("fs");
    const file = __dirname + "/data/feedback.json";
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(file, "utf8")); } catch(e) {}
    arr.push(entry);
    fs.writeFileSync(file, JSON.stringify(arr, null, 2));
  });
  await page.exposeFunction("dbGetFeedback", () => {
    const fs = require("fs");
    const file = __dirname + "/data/feedback.json";
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch(e) { return []; }
  });
  await page.exposeFunction("dbResolveFeedback", (index) => {
    const fs = require("fs");
    const file = __dirname + "/data/feedback.json";
    let arr = [];
    try { arr = JSON.parse(fs.readFileSync(file, "utf8")); } catch(e) {}
    const open = arr.filter(f => !f.resolved);
    if (index < 0 || index >= open.length) return false;
    open[index].resolved = true;
    fs.writeFileSync(file, JSON.stringify(arr, null, 2));
    return true;
  });

  // WebSocket server for abilities
  const wss = new WebSocketServer({ host: "127.0.0.1", port: 4200 });
  let wsIdCounter = 0;
  const wsIds = new Map(); // ws -> unique wsId
  const wsById = new Map(); // wsId -> ws (for sending back)
  wss.on("listening", () => console.log("[WS] Ability server on 127.0.0.1:4200"));
  wss.on("error", (e) => console.log("[WS] Server error:", e.message));
  wss.on("connection", (ws) => {
    const wsId = ++wsIdCounter;
    wsIds.set(ws, wsId);
    wsById.set(wsId, ws);
    ws.on("message", (raw) => {
      try {
        const data = JSON.parse(raw);
        if (data.type === "identify" && data.name) {
          page.evaluate((wsId, name) => {
            if (window.handleExtensionIdentify) window.handleExtensionIdentify(wsId, name);
          }, wsId, data.name).catch(() => {});
        }
        if (data.type === "keydown" && data.slot) {
          page.evaluate((wsId, slot) => {
            if (window.handleAbilityByWs) window.handleAbilityByWs(wsId, slot);
          }, wsId, data.slot).catch((e) => console.log("[WS] evaluate error:", e.message));
        }
      } catch (e) {}
    });
    ws.on("close", () => { wsIds.delete(ws); wsById.delete(wsId); });
  });

  // Expose function for room.js to send state updates to a specific player's extension
  await page.exposeFunction("wsSendToPlayer", (wsId, data) => {
    const ws = wsById.get(wsId);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
  });

  await page.waitForFunction(() => typeof HBInit !== "undefined", { timeout: 15000 });

  await page.evaluate(function (t, stads, i18nData) {
    // --- CONSTANTS ---
    var SCORE_LIMIT = 3;
    var TIME_LIMIT = 3;
    var PRE_GAME_DELAY = 10000; // 10 seconds before fresh game start (allows character selection)
    var AFK_WARN_TIME = 4000; // 4 seconds before warning
    var AFK_KICK_TIME = 4000; // 4 more seconds before kick
    var PICK_TIMEOUT = 20000; // 20 seconds to pick
    var PICK_WARN_TIME = 13000; // warn at 13s (7s remaining)
    var SLOW_MODE_DURING_PICKS = 2000; // 2s chat cooldown during picks
    var RAGEQUIT_THRESHOLD = 0.75; // 75% of time elapsed
    var RAGEQUIT_GOAL_DIFF = 2; // losing by 2+ goals
    var ELO_K = 32;
    var ELO_START = 1000;
    var ELO_LEVELS = [
      { min: 2000, name: "God", emoji: "👁️", color: 0xFF4500 },
      { min: 1900, name: "Immortal", emoji: "🛡️", color: 0xFF6347 },
      { min: 1800, name: "Legend", emoji: "🏆", color: 0xFFD700 },
      { min: 1700, name: "Mythic", emoji: "🐉", color: 0xDA70D6 },
      { min: 1650, name: "Diamond", emoji: "💎", color: 0xB9F2FF },
      { min: 1600, name: "Champion", emoji: "💠", color: 0x7DF9FF },
      { min: 1550, name: "Master", emoji: "🌟", color: 0xFFE066 },
      { min: 1500, name: "Star", emoji: "⭐", color: 0xFFC800 },
      { min: 1450, name: "Inferno", emoji: "🔥", color: 0xFF8C00 },
      { min: 1400, name: "Blaze", emoji: "🌶️", color: 0xE8530E },
      { min: 1350, name: "King", emoji: "👑", color: 0xF0C040 },
      { min: 1300, name: "Knight", emoji: "🦁", color: 0xD4A020 },
      { min: 1250, name: "Thunder", emoji: "⚡", color: 0xCDA0F7 },
      { min: 1200, name: "Elite", emoji: "🎯", color: 0x40E0D0 },
      { min: 1150, name: "Platinum", emoji: "🎖️", color: 0xA0E6A0 },
      { min: 1100, name: "Gold", emoji: "🪙", color: 0xD4AF37 },
      { min: 1050, name: "Silver", emoji: "🌀", color: 0xC0C0C0 },
      { min: 1000, name: "Moon", emoji: "🌙", color: 0xB8C4D0 },
      { min: 950, name: "Bronze", emoji: "🔸", color: 0xCD7F32 },
      { min: 900, name: "Copper", emoji: "🔶", color: 0xB87333 },
      { min: 850, name: "Iron", emoji: "⛏️", color: 0xA0A0A0 },
      { min: 800, name: "Tin", emoji: "🔧", color: 0x8C8C8C },
      { min: 750, name: "Stone", emoji: "🪨", color: 0x808080 },
      { min: 700, name: "Clay", emoji: "🧱", color: 0xA0522D },
      { min: 650, name: "Slug", emoji: "🐌", color: 0x7A8B50 },
      { min: 600, name: "Worm", emoji: "🐛", color: 0x6B8E23 },
      { min: 550, name: "Turtle", emoji: "🐢", color: 0x4E8B4E },
      { min: 500, name: "Egg", emoji: "🥚", color: 0x9B9B6B },
      { min: 450, name: "Ice", emoji: "🧊", color: 0x6BA3BE },
      { min: 400, name: "Frost", emoji: "❄️", color: 0x5B8FA8 },
      { min: 350, name: "Coffin", emoji: "⚰️", color: 0x6B4E4E },
      { min: 300, name: "Ghost", emoji: "👻", color: 0x7B6B8E },
      { min: 250, name: "Skull", emoji: "💀", color: 0x6B6B6B },
      { min: -Infinity, name: "Void", emoji: "🕳️", color: 0x505050 }
    ];

    function getLevel(elo) {
      for (var i = 0; i < ELO_LEVELS.length; i++) {
        if (elo >= ELO_LEVELS[i].min) return ELO_LEVELS[i];
      }
      return ELO_LEVELS[ELO_LEVELS.length - 1];
    }
    var DRAW_TIME_LIMIT = 7 * 60; // 7 minutes in seconds — forced draw

    // --- CHARACTERS ---
    var extensionVerified = {}; // playerId -> true
    var wsToPlayer = {}; // wsId -> playerId
    var playerToWs = {}; // playerId -> wsId

    window.handleExtensionIdentify = function(wsId, name) {
      var players = room.getPlayerList();
      for (var i = 0; i < players.length; i++) {
        if (players[i].name === name) {
          extensionVerified[players[i].id] = true;
          wsToPlayer[wsId] = players[i].id;
          playerToWs[players[i].id] = wsId;
          room.sendAnnouncement("✅ Extension connected!", players[i].id, 0x00FF00, "normal");
          setTimeout(organize, 0);
          return;
        }
      }
    };

    window.handleAbilityByWs = function(wsId, slot) {
      var pid = wsToPlayer[wsId];
      if (!pid) return;
      window.handleAbility(pid, slot);
    };

    var CHARACTERS = {
      bomber:    { name: "Bomber",    emoji: "🧨", color: 0xFF4444, slots: ["mine", "blast", "self_destruct"] },
      speedster: { name: "Speedster", emoji: "⚡", color: 0xFFFF00, slots: ["dash", "sprint", "phase"] },
      guardian:  { name: "Guardian",  emoji: "🛡️", color: 0x4488FF, slots: ["wall", "push", "fortress"] },
      frost:     { name: "Frost",     emoji: "🧊", color: 0x88DDFF, slots: ["ice_patch", "freeze_ray", "blizzard"] },
      striker:   { name: "Striker",   emoji: "🔥", color: 0xFF6600, slots: ["power_shot", "pull", "rocket"] },
      trickster: { name: "Trickster", emoji: "👻", color: 0xCC66FF, slots: ["swap", "blink", "banish"] }
    };
    var playerCharacter = {};  // playerId -> character key
    var ultCharge = {};        // playerId -> 0-100
    function getPlayerCharacter(pid) {
      return playerCharacter[pid] || "bomber";
    }
    function addUltCharge(pid, amount) {
      if (!ultCharge[pid]) ultCharge[pid] = 0;
      if (ultCharge[pid] >= 100) return;
      ultCharge[pid] = Math.min(100, ultCharge[pid] + amount);
      if (ultCharge[pid] >= 100) {
        var p = room.getPlayer(pid);
        if (p) {
          var charKey = getPlayerCharacter(pid);
          var c = CHARACTERS[charKey];
          room.sendAnnouncement("⚡ " + p.name + "'s ULTIMATE is ready! [" + c.slots[2] + "]", null, c.color, "bold");
        }
      }
    }

    // --- STATE ---
    var currentMap = "training";
    var queue = [];
    var redTeam = [];   // ordered list of player ids on red
    var blueTeam = [];  // ordered list of player ids on blue
    var picking = false;
    var pickOrder = [];
    var pickIndex = 0;
    var gameRunning = false;
    var gamePausedForPick = false;
    var preGameTimer = null;
    var lastActivity = {}; // playerId -> timestamp
    var afkWarned = {};    // playerId -> true if warned
    var afkInterval = null;
    var matchStartTime = 0;
    var matchPlayers = []; // players present at kickoff
    var lastKicker = null; // last player who kicked the ball
    var prevKicker = null; // second-to-last kicker (for assists)
    var gkTicks = {}; // playerId -> number of ticks as deepest player
    var lastBallPos = null;
    var ballSpeed = 0;
    var pickTimeout = null;
    var pickWarnTimeout = null;
    var slowModeSet = {}; // playerId -> true if in cooldown
    var afkPlayers = {}; // playerId -> true if voluntarily AFK
    var playerAuths = {}; // playerId -> auth string
    var winStreak = 0; // current consecutive wins by same team
    var lastWinnerTeam = 0; // 1=red, 2=blue
    var chatHistory = []; // { id, time } recent messages for spam detection
    var playerRanks = {}; // auth -> leaderboard position
    var playerLang = {}; // playerId -> "en" or "pt"
    var DEFAULT_LANG = "pt";
    var i18n = i18nData;

    function msg(playerId, key, vars) {
      var lang = playerLang[playerId] || DEFAULT_LANG;
      var str = (i18n[lang] && i18n[lang][key]) || (i18n.en && i18n.en[key]) || key;
      if (vars) {
        for (var k in vars) str = str.replace(new RegExp("\\{" + k + "\\}", "g"), vars[k]);
      }
      return str;
    }
    function msgAll(key, vars) {
      return msg(null, key, vars);
    }
    function broadcast(key, vars, color, style) {
      var players = room.getPlayerList();
      for (var i = 0; i < players.length; i++) {
        if (players[i].id === 0) continue;
        try {
          room.sendAnnouncement(msg(players[i].id, key, vars), players[i].id, color, style);
        } catch(e) { console.log("broadcast error: " + e); }
      }
    }

    function refreshLeaderboard() {
      dbGetAllPlayers().then(function (all) {
        var list = [];
        for (var key in all) list.push({ auth: key, elo: all[key].elo || ELO_START });
        list.sort(function (a, b) { return b.elo - a.elo; });
        playerRanks = {};
        for (var i = 0; i < list.length; i++) playerRanks[list[i].auth] = i + 1;
        // Update avatars for all players in room
        for (var pid in playerAuths) {
          var auth = playerAuths[pid];
          var rank = playerRanks[auth];
          var elo = (all[auth] && all[auth].elo) || ELO_START;
          var charKey = getPlayerCharacter(parseInt(pid));
          var avatar = CHARACTERS[charKey] ? CHARACTERS[charKey].emoji : getLevel(elo).emoji;
          room.setPlayerAvatar(parseInt(pid), avatar);
        }
      });
    }

    var room = HBInit({
      roomName: "⚽ Futsal Ranked (Testing)",
      maxPlayers: 12,
      public: false,
      noPlayer: true,
      token: t,
    });

    room.setCustomStadium(stads.training);
    room.setScoreLimit(0);
    room.setTimeLimit(0);
    room.setTeamsLock(true);
    refreshLeaderboard();

    // --- HELPERS ---
    function allPlayers() {
      return room.getPlayerList().filter(function (p) { return p.id !== 0; });
    }
    function getRedCaptain() { return redTeam.length > 0 ? redTeam[0] : null; }
    function getBlueCaptain() { return blueTeam.length > 0 ? blueTeam[0] : null; }

    function addToQueue(id) {
      if (queue.indexOf(id) === -1) queue.push(id);
      room.setPlayerTeam(id, 0);
    }
    function removeFromQueue(id) {
      queue = queue.filter(function (qid) { return qid !== id; });
    }
    function isEligible(pid) {
      return !afkPlayers[pid] && extensionVerified[pid];
    }
    function firstAvailableInQueue() {
      for (var i = 0; i < queue.length; i++) {
        if (isEligible(queue[i])) return queue[i];
      }
      return null;
    }
    function availableQueueCount() {
      var count = 0;
      for (var i = 0; i < queue.length; i++) {
        if (isEligible(queue[i])) count++;
      }
      return count;
    }
    function removeFromTeam(id) {
      redTeam = redTeam.filter(function (pid) { return pid !== id; });
      blueTeam = blueTeam.filter(function (pid) { return pid !== id; });
    }

    function targetMode(totalPlayers) {
      if (totalPlayers <= 1) return "training";
      if (totalPlayers <= 5) return "x1";
      return "x3";
    }
    function activePlayerCount() {
      return allPlayers().filter(function (p) { return !afkPlayers[p.id]; }).length;
    }
    function teamSizeForMode(mode, playerCount) {
      if (mode === "x3") return 3;
      if (mode === "x1") {
        var count = playerCount !== undefined ? playerCount : allPlayers().length;
        if (count >= 4) return 2;
        return 1;
      }
      return 1;
    }
    function currentTeamSize() { return teamSizeForMode(currentMap); }

    function loadMap(target) {
      if (target === currentMap) return false;
      currentMap = target;
      room.stopGame();
      gameRunning = false;
      room.setCustomStadium(stads[target]);
      room.setScoreLimit(target === "training" ? 0 : SCORE_LIMIT);
      room.setTimeLimit(target === "training" ? 0 : TIME_LIMIT);
      return true;
    }

    function setPlayerToTeam(id, team) {
      room.setPlayerTeam(id, team);
      if (team === 1) {
        if (redTeam.indexOf(id) === -1) redTeam.push(id);
        blueTeam = blueTeam.filter(function (pid) { return pid !== id; });
      } else if (team === 2) {
        if (blueTeam.indexOf(id) === -1) blueTeam.push(id);
        redTeam = redTeam.filter(function (pid) { return pid !== id; });
      } else {
        removeFromTeam(id);
      }
      removeFromQueue(id);
    }

    function startGameWithDelay() {
      if (preGameTimer) clearTimeout(preGameTimer);
      var reds = redTeam.length;
      var blues = blueTeam.length;
      var mode = reds >= 3 ? "3v3" : (reds >= 2 ? "2v2" : "1v1");
      broadcast("startingIn5", { mode: mode }, 0xFFCC00, "bold");
      preGameTimer = setTimeout(function () {
        preGameTimer = null;
        room.startGame();
        gameRunning = true;
        matchStartTime = Date.now();
        gamePausedForPick = false;
      }, PRE_GAME_DELAY);
    }

    function stopGame() {
      if (preGameTimer) { clearTimeout(preGameTimer); preGameTimer = null; }
      room.stopGame();
      gameRunning = false;
    }

    function pauseForPick() {
      if (gameRunning) room.pauseGame(true);
      gamePausedForPick = true;
    }
    function unpauseAfterPick() {
      if (gamePausedForPick && gameRunning) room.pauseGame(false);
      gamePausedForPick = false;
    }

    // --- PICK PHASE ---
    function clearPickTimers() {
      if (pickTimeout) { clearTimeout(pickTimeout); pickTimeout = null; }
      if (pickWarnTimeout) { clearTimeout(pickWarnTimeout); pickWarnTimeout = null; }
    }

    function startPickPhase() {
      clearPickTimers();
      if (availableQueueCount() === 0 || pickIndex >= pickOrder.length) {
        finishPicking();
        return;
      }
      picking = true;
      var current = pickOrder[pickIndex];
      var cap = room.getPlayer(current.captain);
      if (!cap) { picking = false; organize(); return; }

      var teamName = current.team === 1 ? "Red" : "Blue";
      var availQueue = [];
      for (var i = 0; i < queue.length; i++) {
        if (isEligible(queue[i])) availQueue.push(queue[i]);
      }
      if (availQueue.length === 0) { finishPicking(); return; }
      var msg2 = msg(current.captain, "pickPrompt", { team: teamName });
      for (var i = 0; i < availQueue.length; i++) {
        var p = room.getPlayer(availQueue[i]);
        if (p) msg2 += "  " + (i + 1) + ". " + p.name + "\n";
      }
      room.sendAnnouncement(msg2, current.captain, 0x00FFFF, "bold");
      broadcast("pickWaiting", { team: teamName }, 0xFFCC00, "normal");

      // Pick timeout
      pickWarnTimeout = setTimeout(function () {
        var c = pickOrder[pickIndex];
        if (c) room.sendAnnouncement(msg(c.captain, "pickWarn"), c.captain, 0xFF0000, "bold");
      }, PICK_WARN_TIME);

      pickTimeout = setTimeout(function () {
        var c = pickOrder[pickIndex];
        if (c && picking) {
          room.kickPlayer(c.captain, msgAll("pickTooSlow"), false);
        }
      }, PICK_TIMEOUT);
    }

    function finishPicking() {
      clearPickTimers();
      // Auto-assign any remaining available queue players
      while (availableQueueCount() > 0) {
        var id = firstAvailableInQueue();
        if (redTeam.length < currentTeamSize()) {
          setPlayerToTeam(id, 1);
        } else if (blueTeam.length < currentTeamSize()) {
          setPlayerToTeam(id, 2);
        } else {
          break; // teams full, rest stay in queue
        }
      }
      picking = false;

      if (gamePausedForPick && gameRunning) {
        unpauseAfterPick();
      } else {
        startGameWithDelay();
      }
    }

    function buildPickOrder(redNeed, blueNeed) {
      pickOrder = [];
      var r = redNeed, b = blueNeed;
      var turn = "red";
      while (r > 0 || b > 0) {
        if (turn === "red" && r > 0) {
          pickOrder.push({ captain: getRedCaptain(), team: 1 });
          r--; turn = "blue";
        } else if (turn === "blue" && b > 0) {
          pickOrder.push({ captain: getBlueCaptain(), team: 2 });
          b--; turn = "red";
        } else if (r > 0) {
          pickOrder.push({ captain: getRedCaptain(), team: 1 }); r--;
        } else if (b > 0) {
          pickOrder.push({ captain: getBlueCaptain(), team: 2 }); b--;
        }
      }
      pickIndex = 0;
    }

    // --- REBALANCE: keep teams even ---
    function rebalanceTeams() {
      var maxPerTeam = currentTeamSize();

      // Trim excess from teams (last in list moves to queue)
      while (redTeam.length > maxPerTeam) {
        var removed = redTeam[redTeam.length - 1];
        addToQueue(removed);
        redTeam.pop();
      }
      while (blueTeam.length > maxPerTeam) {
        var removed = blueTeam[blueTeam.length - 1];
        addToQueue(removed);
        blueTeam.pop();
      }

      // If uneven, move last from bigger team to smaller
      while (redTeam.length > blueTeam.length + 1) {
        var moved = redTeam[redTeam.length - 1];
        redTeam.pop();
        setPlayerToTeam(moved, 2);
      }
      while (blueTeam.length > redTeam.length + 1) {
        var moved = blueTeam[blueTeam.length - 1];
        blueTeam.pop();
        setPlayerToTeam(moved, 1);
      }

      // If still uneven by 1 and we need even, move last from bigger to queue
      if (redTeam.length !== blueTeam.length) {
        if (redTeam.length > blueTeam.length) {
          var extra = redTeam[redTeam.length - 1];
          redTeam.pop();
          addToQueue(extra);
        } else {
          var extra = blueTeam[blueTeam.length - 1];
          blueTeam.pop();
          addToQueue(extra);
        }
      }
    }

    // --- ORGANIZE: split into focused functions ---

    function resetPickState() {
      picking = false;
      pickOrder = [];
      pickIndex = 0;
      clearPickTimers();
      if (preGameTimer) { clearTimeout(preGameTimer); preGameTimer = null; }
    }

    function organizeEmpty() {
      loadMap("training");
      queue = []; redTeam = []; blueTeam = [];
      gameRunning = false;
    }

    function organizeTraining() {
      stopGame();
      loadMap("training");
      var active = allPlayers().filter(function (p) { return !afkPlayers[p.id]; });
      if (active.length === 0) { organizeEmpty(); return; }
      var solo = active[0];
      queue = [];
      redTeam = [solo.id]; blueTeam = [];
      room.setPlayerTeam(solo.id, 1);
      room.startGame();
      gameRunning = true;
    }

    function organize1v1() {
      loadMap("x1");
      // Already valid 1v1 running — do nothing
      if (redTeam.length === 1 && blueTeam.length === 1 && gameRunning) return;
      // Winner stays: fill empty side from queue
      if (redTeam.length === 1 && blueTeam.length === 0 && availableQueueCount() > 0) {
        stopGame();
        setPlayerToTeam(firstAvailableInQueue(), 2);
        startGameWithDelay();
        return;
      }
      if (blueTeam.length === 1 && redTeam.length === 0 && availableQueueCount() > 0) {
        stopGame();
        setPlayerToTeam(firstAvailableInQueue(), 1);
        startGameWithDelay();
        return;
      }
      // Fresh 1v1
      stopGame();
      var active = allPlayers().filter(function (p) { return !afkPlayers[p.id]; });
      redTeam = []; blueTeam = []; queue = [];
      setPlayerToTeam(active[0].id, 1);
      setPlayerToTeam(active[1].id, 2);
      startGameWithDelay();
    }

    function trimTeams(maxPerTeam) {
      while (redTeam.length > maxPerTeam) addToQueue(redTeam.pop());
      while (blueTeam.length > maxPerTeam) addToQueue(blueTeam.pop());
    }

    function balanceTeamsFromQueue(maxPerTeam) {
      var attempts = 0;
      while (redTeam.length !== blueTeam.length && attempts < 10) {
        attempts++;
        if (redTeam.length > blueTeam.length) {
          if (blueTeam.length < maxPerTeam && availableQueueCount() > 0) {
            setPlayerToTeam(firstAvailableInQueue(), 2);
          } else {
            var extra = redTeam.pop();
            if (blueTeam.length < maxPerTeam) { setPlayerToTeam(extra, 2); }
            else { addToQueue(extra); }
          }
        } else {
          if (redTeam.length < maxPerTeam && availableQueueCount() > 0) {
            setPlayerToTeam(firstAvailableInQueue(), 1);
          } else {
            var extra = blueTeam.pop();
            if (redTeam.length < maxPerTeam) { setPlayerToTeam(extra, 1); }
            else { addToQueue(extra); }
          }
        }
      }
    }

    function ensureCaptains(maxPerTeam) {
      if (redTeam.length === 0 && availableQueueCount() > 0) {
        setPlayerToTeam(firstAvailableInQueue(), 1);
      }
      if (blueTeam.length === 0 && availableQueueCount() > 0) {
        setPlayerToTeam(firstAvailableInQueue(), 2);
      }
    }

    function organizeDowngrade() {
      rebalanceTeams();
      var newMode = targetMode(redTeam.length + blueTeam.length + queue.length);
      if (newMode !== currentMap) {
        loadMap(newMode);
        organize();
        return;
      }
      if (!gameRunning && redTeam.length > 0 && blueTeam.length > 0 && redTeam.length === blueTeam.length) {
        startGameWithDelay();
      }
    }

    function organizeAutoAssign(maxPerTeam) {
      var autoId = firstAvailableInQueue();
      var targetTeam = (maxPerTeam - redTeam.length) > 0 ? 1 : 2;
      setPlayerToTeam(autoId, targetTeam);
      var autoP = room.getPlayer(autoId);
      var tName = targetTeam === 1 ? "Red" : "Blue";
      broadcast("joins", { name: autoP ? autoP.name : "", team: tName }, 0x00FF00, "bold");
      if (gamePausedForPick) {
        unpauseAfterPick();
      } else if (!gameRunning) {
        startGameWithDelay();
      }
    }

    function organizeStartPicks(maxPerTeam) {
      if (gameRunning) { pauseForPick(); } else { stopGame(); }
      var redNeed = maxPerTeam - redTeam.length;
      var blueNeed = maxPerTeam - blueTeam.length;
      if (redNeed < 0) redNeed = 0;
      if (blueNeed < 0) blueNeed = 0;
      buildPickOrder(redNeed, blueNeed);
      var modeLabel = maxPerTeam >= 3 ? "3v3" : (maxPerTeam >= 2 ? "2v2" : "1v1");
      broadcast("captainsPick", { mode: modeLabel }, 0xFFCC00, "bold");
      startPickPhase();
    }

    // --- MAIN ENTRY POINT ---
    function organize() {
      resetPickState();

      var count = activePlayerCount();

      if (count === 0) { organizeEmpty(); return; }
      if (count === 1) { organizeTraining(); return; }
      if (count === 2) { organize1v1(); return; }

      // 3+ players
      var mode = targetMode(count);
      var maxPerTeam = teamSizeForMode(mode, count);
      var mapChanged = loadMap(mode);
      if (mapChanged && gameRunning) stopGame();

      trimTeams(maxPerTeam);
      balanceTeamsFromQueue(maxPerTeam);

      var totalNeed = (maxPerTeam - redTeam.length) + (maxPerTeam - blueTeam.length);

      // Teams full
      if (totalNeed <= 0 && redTeam.length === blueTeam.length) {
        if (!gameRunning) startGameWithDelay();
        if (queue.length > 0) {
          var next = room.getPlayer(queue[0]);
          var extra = queue.length > 1 ? " (+" + (queue.length - 1) + ")" : "";
          broadcast("queuePosition", { name: next ? next.name : "", extra: extra }, 0x888888, "normal");
        }
        return;
      }

      // Need to fill spots
      ensureCaptains(maxPerTeam);
      totalNeed = (maxPerTeam - redTeam.length) + (maxPerTeam - blueTeam.length);
      if (totalNeed < 0) totalNeed = 0;

      // Can't fill — downgrade
      if (availableQueueCount() === 0 && totalNeed > 0) { organizeDowngrade(); return; }

      // Auto-assign single spot
      if (totalNeed === 1 && availableQueueCount() >= 1) { organizeAutoAssign(maxPerTeam); return; }

      // Multiple picks needed
      organizeStartPicks(maxPerTeam);
    }

    // --- WINNER STAYS LOGIC ---
    function handleDraw() {
      winStreak = 0;
      lastWinnerTeam = 0;
      broadcast("draw", 0xFFCC00, "bold");
      stopGame();

      // Record draw for players present from kickoff
      var participants = redTeam.concat(blueTeam);
      for (var i = 0; i < participants.length; i++) {
        (function (pid) {
          var auth = playerAuths[pid];
          if (!auth) return;
          if (matchPlayers.indexOf(pid) === -1) return;
          dbGetPlayer(auth).then(function (p) {
            var data = p || { name: "", games: 0, losses: 0, draws: 0 };
            var pl = room.getPlayer(pid);
            if (pl) data.name = pl.name;
            data.games = (data.games || 0) + 1;
            data.draws = (data.draws || 0) + 1;
            dbSavePlayer(auth, data);
          });
        })(participants[i]);
      }

      // Everyone to queue
      for (var i = 0; i < participants.length; i++) {
        addToQueue(participants[i]);
      }
      redTeam = [];
      blueTeam = [];
      organize();
    }

    function handleMatchEnd(scores) {
      gameRunning = false;
      var redWon = scores.red > scores.blue;
      var blueWon = scores.blue > scores.red;
      var participants = redTeam.concat(blueTeam);
      var redAtEnd = redTeam.slice();
      var blueAtEnd = blueTeam.slice();

      if (redWon) {
        if (lastWinnerTeam === 1) { winStreak++; } else { winStreak = 1; lastWinnerTeam = 1; }
        broadcast("redWins", 0xFF4444, "bold");
        if (winStreak >= 3) broadcast("streak", { team: "Red", count: winStreak }, 0xFF8800, "bold");
      } else if (blueWon) {
        if (lastWinnerTeam === 2) { winStreak++; } else { winStreak = 1; lastWinnerTeam = 2; }
        broadcast("blueWins", 0x4444FF, "bold");
        if (winStreak >= 3) broadcast("streak", { team: "Blue", count: winStreak }, 0xFF8800, "bold");
      }

      // GK detection: player with most ticks as deepest on their team (>50%)
      function findGK(teamIds) {
        var best = null, bestTicks = 0, teamTotal = 0;
        for (var i = 0; i < teamIds.length; i++) {
          var t = gkTicks[teamIds[i]] || 0;
          teamTotal += t;
          if (t > bestTicks) { bestTicks = t; best = teamIds[i]; }
        }
        return (best && teamTotal > 0 && bestTicks / teamTotal >= 0.5) ? best : null;
      }

      // Record games/wins/losses — for all players on teams at match end
      for (var i = 0; i < participants.length; i++) {
        (function (pid) {
          var auth = playerAuths[pid];
          if (!auth) return;
          var lost = (redWon && blueAtEnd.indexOf(pid) !== -1) || (blueWon && redAtEnd.indexOf(pid) !== -1);
          var won = (redWon && redAtEnd.indexOf(pid) !== -1) || (blueWon && blueAtEnd.indexOf(pid) !== -1);
          var isRedGK = (pid === findGK(redAtEnd));
          var isBlueGK = (pid === findGK(blueAtEnd));
          var earnedCS = (isRedGK && scores.blue === 0) || (isBlueGK && scores.red === 0);
          dbGetPlayer(auth).then(function (p) {
            var data = p || { name: "", games: 0, wins: 0, losses: 0, draws: 0 };
            var pl = room.getPlayer(pid);
            if (pl) data.name = pl.name;
            data.games = (data.games || 0) + 1;
            if (won) {
              data.wins = (data.wins || 0) + 1;
              data.winStreak = (data.winStreak || 0) + 1;
              if (data.winStreak > (data.bestStreak || 0)) data.bestStreak = data.winStreak;
              if (data.winStreak >= 3 && pl) {
                broadcast("personalStreak", { name: pl.name, count: data.winStreak }, 0xFF8800, "normal");
              }
            }
            if (lost) {
              data.losses = (data.losses || 0) + 1;
              data.winStreak = 0;
            }
            if (earnedCS) {
              data.cleanSheets = (data.cleanSheets || 0) + 1;
              if (pl) broadcast("cleanSheet", { name: pl.name }, 0x00FFAA, "bold");
            }
            dbSavePlayer(auth, data);
          });
        })(participants[i]);
      }

      // ELO update — only for 3v3 (ranked), both teams must have 3 at match end
      if (currentMap === "x3" && redAtEnd.length === 3 && blueAtEnd.length === 3) {
          // Get all auths and compute opponent team average
          var allAuths = [];
          for (var i = 0; i < redAtEnd.length; i++) allAuths.push({ pid: redAtEnd[i], team: "red" });
          for (var i = 0; i < blueAtEnd.length; i++) allAuths.push({ pid: blueAtEnd[i], team: "blue" });

          // Fetch all players then compute
          var promises = allAuths.map(function (entry) {
            return dbGetPlayer(playerAuths[entry.pid]).then(function (p) {
              return { pid: entry.pid, team: entry.team, elo: (p && p.elo) ? p.elo : ELO_START, auth: playerAuths[entry.pid] };
            });
          });
          Promise.all(promises).then(function (players) {
            var redAvg = 0, blueAvg = 0;
            var reds = players.filter(function (p) { return p.team === "red"; });
            var blues = players.filter(function (p) { return p.team === "blue"; });
            for (var i = 0; i < reds.length; i++) redAvg += reds[i].elo;
            for (var i = 0; i < blues.length; i++) blueAvg += blues[i].elo;
            redAvg /= 3; blueAvg /= 3;

            for (var i = 0; i < players.length; i++) {
              var p = players[i];
              var opponentAvg = p.team === "red" ? blueAvg : redAvg;
              var result = (p.team === "red" && redWon) || (p.team === "blue" && blueWon) ? 1 : 0;
              var expected = 1 / (1 + Math.pow(10, (opponentAvg - p.elo) / 400));
              var change = Math.round(ELO_K * (result - expected));
              var newElo = p.elo + change;
              dbGetPlayer(p.auth).then(function (auth, ne) { return function (data) {
                data = data || {};
                data.elo = ne;
                dbSavePlayer(auth, data);
              }; }(p.auth, newElo));
              var pl = room.getPlayer(p.pid);
              var sign = change >= 0 ? "+" : "";
              if (pl) {
                var oldLevel = getLevel(p.elo);
                var newLevel = getLevel(newElo);
                room.sendAnnouncement(msg(p.pid, "eloChange", { name: pl.name, sign: sign, change: change, elo: newElo, level: newLevel.name }), pl.id, change >= 0 ? 0x00FF00 : 0xFF4444, "normal");
                if (newLevel.min > oldLevel.min) {
                  broadcast("rankUp", { name: pl.name, level: newLevel.name, emoji: newLevel.emoji }, 0x00FF00, "bold");
                }
              }
            }
            refreshLeaderboard();
          });
      }

      // Wait for victory screen, then stop and reorganize
      setTimeout(function () {
        stopGame();

        var teamSize = teamSizeForMode(currentMap, allPlayers().length);
        var totalPlayers = allPlayers().length;
        var exactMinimum = (totalPlayers === teamSize * 2);

        if (exactMinimum) {
          // Exactly minimum players: randomize all
          for (var i = 0; i < redTeam.length; i++) addToQueue(redTeam[i]);
          for (var i = 0; i < blueTeam.length; i++) addToQueue(blueTeam[i]);
          redTeam = []; blueTeam = [];
          // Shuffle queue
          for (var i = queue.length - 1; i > 0; i--) {
            var j = Math.floor(Math.random() * (i + 1));
            var tmp = queue[i]; queue[i] = queue[j]; queue[j] = tmp;
          }
          // Fill teams
          for (var i = 0; i < teamSize; i++) {
            setPlayerToTeam(queue[0], 1);
          }
          for (var i = 0; i < teamSize; i++) {
            setPlayerToTeam(queue[0], 2);
          }
          startGameWithDelay();
        } else {
          // Winner stays: move losers to queue, winners to red
          if (redWon) {
            for (var i = 0; i < blueTeam.length; i++) addToQueue(blueTeam[i]);
            blueTeam = [];
          } else if (blueWon) {
            for (var i = 0; i < redTeam.length; i++) addToQueue(redTeam[i]);
            redTeam = [];
            for (var i = 0; i < blueTeam.length; i++) {
              room.setPlayerTeam(blueTeam[i], 1);
              redTeam.push(blueTeam[i]);
            }
            blueTeam = [];
          }

          // Fill blue: first from queue becomes captain, then picks if needed
          var captainId = firstAvailableInQueue();
          setPlayerToTeam(captainId, 2);
          var remaining = teamSize - 1;

          if (remaining === 0 || availableQueueCount() === 0) {
            startGameWithDelay();
          } else if (remaining === 1 && availableQueueCount() === 1) {
            // Auto-assign last one
            setPlayerToTeam(firstAvailableInQueue(), 2);
            startGameWithDelay();
          } else {
            // Captain picks
            buildPickOrder(0, remaining);
            broadcast("captainsPick", { mode: teamSize >= 3 ? "3v3" : "2v2" }, 0xFFCC00, "bold");
            startPickPhase();
          }
        }
      }, 3000);
    }

    // --- AFK DETECTION ---
    function recordActivity(playerId) {
      lastActivity[playerId] = Date.now();
      afkWarned[playerId] = false;
    }

    function startAfkCheck() {
      if (afkInterval) return;
      afkInterval = setInterval(function () {
        if (!gameRunning) return;
        if (redTeam.length + blueTeam.length <= 1) return; // No AFK check when solo
        var now = Date.now();
        // Only check players on teams (not spectators/queue)
        var playing = redTeam.concat(blueTeam);
        for (var i = 0; i < playing.length; i++) {
          var pid = playing[i];
          var last = lastActivity[pid] || now;
          var idle = now - last;
          if (idle >= AFK_WARN_TIME + AFK_KICK_TIME) {
            // Kick
            room.kickPlayer(pid, msgAll("afkKick"), false);
          } else if (idle >= AFK_WARN_TIME && !afkWarned[pid]) {
            afkWarned[pid] = true;
            room.sendAnnouncement(msg(pid, "afkWarn"), pid, 0xFF0000, "bold");
          }
        }
      }, 1000);
    }
    // AFK CHECK DISABLED FOR TESTING
    // startAfkCheck();

    // --- EVENTS ---
    room.onRoomLink = function (url) { window.__roomLink = url; console.log("ROOM_LINK:" + url); };

    room.onPlayerJoin = function (player) {
      playerAuths[player.id] = player.auth;
      // Clear any leftover spam history for this player
      chatHistory = chatHistory.filter(function (m) { return m.id !== player.id; });
      // Set language: default PT (Portuguese room), players can switch with !en
      playerLang[player.id] = "pt";
      // Auto-admin for owner
      if (player.auth === "IfMffZmKYde2AuH5mzo2S0CpfhPh6fxQC9dedCbJvf8") {
        room.setPlayerAdmin(player.id, true);
        broadcast("adminGranted", { name: player.name }, 0xFF8800, "bold");
      }
      // Set avatar based on ELO level and ensure player exists in DB
      if (player.auth) {
        dbGetPlayer(player.auth).then(function (p) {
          if (!p) {
            dbSavePlayer(player.auth, { name: player.name, elo: ELO_START, character: "bomber" });
            refreshLeaderboard();
          }
          var elo = (p && p.elo) ? p.elo : ELO_START;
          var level = getLevel(elo);
          var rank = playerRanks[player.auth];
          // Restore character and set avatar to character emoji
          if (p && p.character && CHARACTERS[p.character]) {
            playerCharacter[player.id] = p.character;
            room.setPlayerAvatar(player.id, CHARACTERS[p.character].emoji);
          } else {
            room.setPlayerAvatar(player.id, CHARACTERS["bomber"].emoji);
          }
        });
      }
      var pos = availableQueueCount() + 1;
      if (gameRunning || redTeam.length > 0 || blueTeam.length > 0) {
        room.sendAnnouncement(msg(player.id, "welcomeQueue", { name: player.name, pos: pos }), player.id, 0x00FF00, "bold");
      } else {
        room.sendAnnouncement(msg(player.id, "welcome", { name: player.name }), player.id, 0x00FF00, "bold");
      }
      room.sendAnnouncement("🌐 Type !en for English | Digite !pt para Português", player.id, 0x888888, "normal");

      // Extension detection: remind every 60s until verified
      var pid = player.id;
      var extCheck = setInterval(function () {
        if (extensionVerified[pid]) { clearInterval(extCheck); return; }
        var pl = room.getPlayer(pid);
        if (!pl) { clearInterval(extCheck); return; }
        room.sendAnnouncement("⚠️ Extension required to play! Install it: github.com/Dzithi/haxball-abilities", pid, 0xFF4444, "bold");
      }, 60000);
      // Also warn after 5s initially
      setTimeout(function () {
        if (!extensionVerified[pid]) {
          var pl = room.getPlayer(pid);
          if (pl) room.sendAnnouncement("⚠️ Extension required to play! Install it: github.com/Dzithi/haxball-abilities", pid, 0xFF4444, "bold");
        }
      }, 5000);

      addToQueue(player.id);
      recordActivity(player.id);

      var all = allPlayers();
      var newMode = targetMode(activePlayerCount());
      var newTeamSize = teamSizeForMode(newMode, activePlayerCount());
      var currentTeamSizeVal = teamSizeForMode(currentMap, activePlayerCount() - 1);

      if (picking) {
        // During active pick: update mode/map if needed, rebuild pick order, refresh list
        setTimeout(function () { refreshPickPhase(); }, 0);
      } else if (newMode !== currentMap) {
        setTimeout(function () { organizeUpgrade(newMode); }, 0);
      } else if (newTeamSize > currentTeamSizeVal) {
        setTimeout(function () { organizeMidMatchFill(); }, 0);
      } else if (!gameRunning) {
        setTimeout(organize, 0);
      }
    };

    // Refresh pick phase: update mode if needed, rebuild remaining picks, resend list
    function refreshPickPhase() {
      var all = allPlayers();
      var newMode = targetMode(all.length);
      if (newMode !== currentMap) {
        stopGame();
        loadMap(newMode);
        gamePausedForPick = false;
      }
      var maxPerTeam = teamSizeForMode(currentMap, all.length);
      var redNeed = maxPerTeam - redTeam.length;
      var blueNeed = maxPerTeam - blueTeam.length;
      if (redNeed < 0) redNeed = 0;
      if (blueNeed < 0) blueNeed = 0;
      var totalNeed = redNeed + blueNeed;

      if (totalNeed === 0) {
        finishPicking();
        return;
      }

      // Auto-assign if only 1 available in queue
      if (availableQueueCount() === 1 && totalNeed >= 1) {
        var autoId = firstAvailableInQueue();
        var autoP = room.getPlayer(autoId);
        var targetTeam = redNeed > 0 ? 1 : 2;
        setPlayerToTeam(autoId, targetTeam);
        var tn = targetTeam === 1 ? "Red" : "Blue";
        broadcast("autoJoins", { name: autoP ? autoP.name : "", team: tn }, 0x00FF00, "bold");
        // Recalculate remaining need
        redNeed = maxPerTeam - redTeam.length;
        blueNeed = maxPerTeam - blueTeam.length;
        if (redNeed < 0) redNeed = 0;
        if (blueNeed < 0) blueNeed = 0;
        totalNeed = redNeed + blueNeed;
        if (totalNeed === 0 || availableQueueCount() === 0) {
          finishPicking();
          return;
        }
      }

      // Rebuild pick order from current position
      buildPickOrder(redNeed, blueNeed);
      startPickPhase();
    }

    // Upgrade: map change required, keep existing teams, pick remaining from queue
    function organizeUpgrade(newMode) {
      stopGame();
      loadMap(newMode);
      var maxPerTeam = teamSizeForMode(newMode, allPlayers().length);

      // Keep current team members, they stay
      var redNeed = maxPerTeam - redTeam.length;
      var blueNeed = maxPerTeam - blueTeam.length;
      if (redNeed < 0) redNeed = 0;
      if (blueNeed < 0) blueNeed = 0;
      var totalNeed = redNeed + blueNeed;

      if (totalNeed === 0) {
        startGameWithDelay();
        return;
      }

      // Auto-assign if only 1 spot
      if (totalNeed === 1 && availableQueueCount() >= 1) {
        var autoId = firstAvailableInQueue();
        var targetTeam = redNeed > 0 ? 1 : 2;
        setPlayerToTeam(autoId, targetTeam);
        var p = room.getPlayer(autoId);
        var tn = targetTeam === 1 ? "Red" : "Blue";
        broadcast("joins", { name: p ? p.name : "", team: tn }, 0x00FF00, "bold");
        startGameWithDelay();
        return;
      }

      // Multiple picks needed
      buildPickOrder(redNeed, blueNeed);
      var modeLabel = maxPerTeam >= 3 ? "3v3" : "2v2";
      broadcast("upgrading", { mode: modeLabel }, 0xFFCC00, "bold");
      startPickPhase();
    }

    // Mid-match fill: same map, game running — pause, pick, resume
    function organizeMidMatchFill() {
      var all = allPlayers();
      var maxPerTeam = teamSizeForMode(currentMap, all.length);
      var redNeed = maxPerTeam - redTeam.length;
      var blueNeed = maxPerTeam - blueTeam.length;
      if (redNeed < 0) redNeed = 0;
      if (blueNeed < 0) blueNeed = 0;
      var totalNeed = redNeed + blueNeed;

      if (totalNeed === 0) return;

      // Auto-assign if only 1 spot
      if (totalNeed === 1 && availableQueueCount() >= 1) {
        if (gameRunning) pauseForPick();
        var autoId = firstAvailableInQueue();
        var targetTeam = redNeed > 0 ? 1 : 2;
        setPlayerToTeam(autoId, targetTeam);
        var p = room.getPlayer(autoId);
        var tn = targetTeam === 1 ? "Red" : "Blue";
        broadcast("joins", { name: p ? p.name : "", team: tn }, 0x00FF00, "bold");
        unpauseAfterPick();
        return;
      }

      // Multiple picks — pause game, captains pick, then resume
      if (gameRunning) pauseForPick();
      buildPickOrder(redNeed, blueNeed);
      var modeLabel = maxPerTeam >= 2 ? "2v2" : "1v1";
      broadcast("upgrading", { mode: modeLabel }, 0xFFCC00, "bold");
      startPickPhase();
    }

    room.onPlayerLeave = function (player) {
      var wasInQueue = queue.indexOf(player.id) !== -1;
      var wasOnRed = redTeam.indexOf(player.id) !== -1;
      var wasOnBlue = blueTeam.indexOf(player.id) !== -1;
      var leaverAuth = playerAuths[player.id];

      // ELO leave penalty — only in ranked 3v3, only if was playing
      if (currentMap === "x3" && gameRunning && (wasOnRed || wasOnBlue) && leaverAuth) {
        var elapsed = (Date.now() - matchStartTime) / 1000;
        if (elapsed >= 10) {
          // Leaver loses ELO and counts as a game lost
          dbGetPlayer(leaverAuth).then(function (p) {
            var data = p || { name: "", games: 0, wins: 0, losses: 0, draws: 0 };
            data.elo = ((data.elo || ELO_START) - 25);
            data.games = (data.games || 0) + 1;
            data.losses = (data.losses || 0) + 1;
            dbSavePlayer(leaverAuth, data);
          });
          broadcast("leavePenalty", { name: player.name }, 0xFF4444, "bold");
          refreshLeaderboard();
        }
      }

      removeFromQueue(player.id);
      removeFromTeam(player.id);
      delete lastActivity[player.id];
      delete afkWarned[player.id];
      delete afkPlayers[player.id];
      delete playerAuths[player.id];
      delete playerLang[player.id];

      if (picking) {
        var current = pickOrder[pickIndex];
        if (current && current.captain === player.id) {
          // Captain left — promote next in their team list
          var newCap = current.team === 1 ? getRedCaptain() : getBlueCaptain();
          if (newCap) {
            current.captain = newCap;
            for (var i = pickIndex + 1; i < pickOrder.length; i++) {
              if (pickOrder[i].team === current.team) pickOrder[i].captain = newCap;
            }
            setTimeout(function () { startPickPhase(); }, 0);
          } else {
            setTimeout(organize, 0);
          }
        } else if (wasInQueue) {
          setTimeout(function () { startPickPhase(); }, 0);
        } else {
          setTimeout(function () { refreshPickPhase(); }, 0);
        }
        return;
      }

      // Forfeit: entire team left while game running
      if (gameRunning && (redTeam.length === 0 || blueTeam.length === 0) && (redTeam.length + blueTeam.length > 0)) {
        var winnerName = redTeam.length > 0 ? "Red" : "Blue";
        broadcast("forfeit", { team: winnerName }, 0xFFCC00, "bold");
        stopGame();
        setTimeout(organize, 0);
        return;
      }

      // Ragequit: losing team player leaves late in game while losing by 2+
      if (gameRunning && currentMap !== "training") {
        var scores = room.getScores();
        if (scores && scores.timeLimit > 0 && scores.time > scores.timeLimit * 60 * RAGEQUIT_THRESHOLD) {
          var diff = scores.red - scores.blue;
          var leaverTeamLosing = (wasOnRed && diff <= -RAGEQUIT_GOAL_DIFF) || (wasOnBlue && diff >= RAGEQUIT_GOAL_DIFF);
          if (leaverTeamLosing && redTeam.length !== blueTeam.length && availableQueueCount() === 0) {
            var winnerName = diff > 0 ? "Red" : "Blue";
            broadcast("ragequit", { team: winnerName }, 0xFFCC00, "bold");
            stopGame();
            setTimeout(organize, 0);
            return;
          }
        }
      }

      setTimeout(organize, 0);
    };

    room.onPlayerChat = function (player, message) {
      recordActivity(player.id);

      // Spam protection: DISABLED FOR DEBUGGING
      /*
      if (message[0] !== "!" && message.substring(0, 2) !== "@@" && !(message.length > 2 && message.substring(0, 2).toLowerCase() === "t ")) {
        var now = Date.now();
        chatHistory.push({ id: player.id, time: now });
        chatHistory = chatHistory.filter(function (m) { return now - m.time < 3000; });
        var count = 0;
        for (var i = 0; i < chatHistory.length; i++) {
          if (chatHistory[i].id === player.id) count++;
        }
        if (count >= 5) {
          room.kickPlayer(player.id, msgAll("spam"), false);
          return false;
        }
      }
      */

      if (message === "!admin futsalzinho99") {
        room.setPlayerAdmin(player.id, true);
        room.sendAnnouncement("🔑 " + msg(player.id, "adminGranted", { name: player.name }), null, 0xFF8800, "bold");
        return false;
      }

      if (message.toLowerCase() === "!bb") {
        room.kickPlayer(player.id, msgAll("bye"), false);
        return false;
      }

      if (message.toLowerCase().startsWith("!feedback")) {
        var text = message.substring(9).trim();
        if (!text) {
          room.sendAnnouncement("Usage: !feedback <your message>", player.id, 0x888888, "normal");
          return false;
        }
        dbSaveFeedback({ name: player.name, auth: playerAuths[player.id], text: text, date: new Date().toISOString(), resolved: false });
        room.sendAnnouncement("✅ Feedback saved! Thanks " + player.name, player.id, 0x00FF00, "normal");
        return false;
      }

      if (message.toLowerCase() === "!showfeedback") {
        if (!player.admin) { room.sendAnnouncement("Admin only.", player.id, 0xFF4444, "normal"); return false; }
        dbGetFeedback().then(function(list) {
          var open = list.filter(function(f) { return !f.resolved; });
          if (open.length === 0) {
            room.sendAnnouncement("📋 No open feedback.", player.id, 0x888888, "normal");
            return;
          }
          for (var i = 0; i < open.length; i++) {
            room.sendAnnouncement("#" + (i + 1) + " [" + open[i].name + "] " + open[i].text + " (" + open[i].date.substring(0, 10) + ")", player.id, 0x00FFFF, "normal");
          }
          room.sendAnnouncement("Use !resolve <number> to resolve", player.id, 0x888888, "normal");
        });
        return false;
      }

      if (message.toLowerCase().startsWith("!resolve")) {
        if (!player.admin) { room.sendAnnouncement("Admin only.", player.id, 0xFF4444, "normal"); return false; }
        var num = parseInt(message.substring(8).trim());
        if (isNaN(num) || num < 1) {
          room.sendAnnouncement("Usage: !resolve <number>", player.id, 0x888888, "normal");
          return false;
        }
        dbResolveFeedback(num - 1).then(function(ok) {
          if (ok) room.sendAnnouncement("✅ Feedback #" + num + " resolved.", player.id, 0x00FF00, "normal");
          else room.sendAnnouncement("❌ Invalid number.", player.id, 0xFF4444, "normal");
        });
        return false;
      }

      if (message.toLowerCase() === "!en") {
        playerLang[player.id] = "en";
        room.sendAnnouncement("🌐 Language set to English.", player.id, 0x888888, "normal");
        return false;
      }

      if (message.toLowerCase() === "!pt") {
        playerLang[player.id] = "pt";
        room.sendAnnouncement("🌐 Idioma definido para Português.", player.id, 0x888888, "normal");
        return false;
      }

      if (message.toLowerCase() === "!help") {
        room.sendAnnouncement("📋 COMMANDS:", player.id, 0x00FFFF, "bold");
        room.sendAnnouncement("⚡ !char <name> — Pick character (bomber, speedster, guardian, frost, striker, trickster)", player.id, 0x00FFFF, "normal");
        room.sendAnnouncement("📖 !abilities <name> — See ability details for a character", player.id, 0x00FFFF, "normal");
        room.sendAnnouncement("📊 !stats — Your stats | !top — Top 5 | !streak — Win streaks", player.id, 0x00FFFF, "normal");
        room.sendAnnouncement("🔍 !rank <name> — Check any player's stats", player.id, 0x00FFFF, "normal");
        room.sendAnnouncement("📬 !feedback <msg> — Send feedback to admins", player.id, 0x00FFFF, "normal");
        room.sendAnnouncement("💤 !afk — Toggle AFK | 👋 !bb — Leave room", player.id, 0x00FFFF, "normal");
        room.sendAnnouncement("💬 t <msg> — Team chat | @@Name <msg> — Private message", player.id, 0x00FFFF, "normal");
        room.sendAnnouncement("🌐 !en — English | !pt — Português", player.id, 0x00FFFF, "normal");
        room.sendAnnouncement("👀 !queue — See queue | !char — See your character", player.id, 0x00FFFF, "normal");
        room.sendAnnouncement("📖 !abilities — See your abilities", player.id, 0x00FFFF, "normal");
        return false;
      }

      if (message.toLowerCase().startsWith("!abilities")) {
        var parts = message.trim().split(/\s+/);
        var target = parts.length > 1 ? parts[1].toLowerCase() : getPlayerCharacter(player.id);
        var descs = {
          bomber: ["1: Mine — Place explosive trap (team color, invisible after 1s). Enemies in range get blasted away. 10s cd", "2: Blast — Detonate ALL your mines at once. 20s cd", "3: Self-Destruct [ULT] — Explode yourself! 80u radius, massive knockback to enemies + ball. You're stunned 1s."],
          speedster: ["1: Dash — Teleport 80u forward instantly. 8s cd", "2: Sprint — +50% speed for 3s. 15s cd", "3: Phase [ULT] — Become untouchable for 1.5s. Immune to everything."],
          guardian: ["1: Wall — Place solid barrier for 4s. Blocks ball + players. 12s cd", "2: Push — Knockback all nearby enemies + ball. 15s cd", "3: Fortress [ULT] — 3-disc barricade in an arc. Lasts 3s."],
          frost: ["1: Ice Patch — Drop slow zone (5s). Enemies get -50% speed. 10s cd", "2: Freeze Ray — Freeze nearest enemy for 2s. Must be close (40u). 18s cd", "3: Blizzard [ULT] — ALL enemies get -30% speed for 3s. Global."],
          striker: ["1: Power Shot — Next kick gets +80% ball speed. 12s cd", "2: Pull — Yank ball to your position (within 100u). 20s cd", "3: Rocket [ULT] — Launch ball at opponent goal. Must be touching ball."],
          trickster: ["1: Swap — Switch positions with nearest teammate. 12s cd", "2: Blink — Random teleport within 120u. 10s cd", "3: Banish [ULT] — Send nearest enemy to their own goal line."]
        };
        if (!descs[target]) {
          room.sendAnnouncement("Unknown character. Options: " + Object.keys(CHARACTERS).join(", "), player.id, 0xFF4444, "normal");
          return false;
        }
        var c = CHARACTERS[target];
        room.sendAnnouncement(c.emoji + " " + c.name + " abilities:", player.id, c.color, "bold");
        for (var i = 0; i < descs[target].length; i++) {
          room.sendAnnouncement(descs[target][i], player.id, c.color, "normal");
        }
        return false;
      }

      if (message.toLowerCase().startsWith("!char")) {
        var parts = message.trim().split(/\s+/);
        if (parts.length < 2) {
          var current = getPlayerCharacter(player.id);
          var charList = Object.keys(CHARACTERS).map(function(k) { return CHARACTERS[k].emoji + " " + k; }).join(", ");
          room.sendAnnouncement("Your character: " + CHARACTERS[current].emoji + " " + current + " | Available: " + charList, player.id, 0x00FFFF, "normal");
          return false;
        }
        var choice = parts[1].toLowerCase();
        if (!CHARACTERS[choice]) {
          room.sendAnnouncement("Unknown character. Options: " + Object.keys(CHARACTERS).join(", "), player.id, 0xFF4444, "normal");
          return false;
        }
        if (gameRunning && player.team !== 0) {
          room.sendAnnouncement("⚠️ Can't switch characters during a game!", player.id, 0xFF4444, "normal");
          return false;
        }
        playerCharacter[player.id] = choice;
        // Persist
        var auth = playerAuths[player.id];
        if (auth) dbSavePlayer(auth, { character: choice });
        var c = CHARACTERS[choice];
        room.setPlayerAvatar(player.id, c.emoji);
        room.sendAnnouncement(c.emoji + " " + player.name + " chose " + c.name + "! [" + c.slots.join(", ") + "]", null, c.color, "bold");
        return false;
      }

      if (message.toLowerCase() === "!queue") {
        var qList = [];
        for (var i = 0; i < queue.length; i++) {
          if (!afkPlayers[queue[i]]) {
            var p = room.getPlayer(queue[i]);
            if (p) qList.push(p.name);
          }
        }
        if (qList.length === 0) {
          room.sendAnnouncement(msg(player.id, "queueEmpty"), player.id, 0x888888, "normal");
        } else {
          var qMsg = "";
          for (var i = 0; i < qList.length; i++) {
            qMsg += (i + 1) + ". " + qList[i] + "  ";
          }
          room.sendAnnouncement(msg(player.id, "queueList", { list: qMsg }), player.id, 0x888888, "normal");
        }
        return false;
      }

      if (message.toLowerCase() === "!me") {
        var auth = playerAuths[player.id];
        if (auth) {
          dbGetPlayer(auth).then(function (p) {
            var d = p || {};
            var elo = d.elo || ELO_START;
            var level = getLevel(elo);
            room.sendAnnouncement(msg(player.id, "statsMsg", {
              emoji: level.emoji, name: player.name, level: level.name, elo: elo,
              games: d.games || 0, wins: d.wins || 0, losses: d.losses || 0,
              draws: d.draws || 0, goals: d.goals || 0, ownGoals: d.ownGoals || 0,
              cleanSheets: d.cleanSheets || 0
            }), player.id, 0x00FFFF, "normal");
            room.sendAnnouncement(msg(player.id, "streakCmd", { name: player.name, current: d.winStreak || 0, best: d.bestStreak || 0 }), player.id, 0xFF8800, "normal");
          });
        }
        return false;
      }

      if (message.toLowerCase() === "!top") {
        dbGetAllPlayers().then(function (all) {
          var list = [];
          for (var key in all) {
            if (all[key].elo) list.push({ name: all[key].name || "???", elo: all[key].elo });
          }
          list.sort(function (a, b) { return b.elo - a.elo; });
          var topMsg = msg(player.id, "topHeader") + "\n";
          for (var i = 0; i < Math.min(5, list.length); i++) {
            var lvl = getLevel(list[i].elo);
            topMsg += "  " + (i + 1) + ". " + lvl.emoji + " " + list[i].name + " (" + list[i].elo + ")\n";
          }
          room.sendAnnouncement(topMsg, player.id, 0xFFCC00, "bold");
        });
        return false;
      }

      if (message.toLowerCase().substring(0, 6) === "!rank ") {
        var targetName = message.substring(6).trim();
        dbGetAllPlayers().then(function (all) {
          for (var key in all) {
            if (all[key].name && all[key].name.toLowerCase() === targetName.toLowerCase()) {
              var d = all[key];
              var elo = d.elo || ELO_START;
              var level = getLevel(elo);
              var pos = playerRanks[key] ? "#" + playerRanks[key] : "?";
              room.sendAnnouncement(level.emoji + " " + d.name + " [" + pos + "] [" + elo + "] | W: " + (d.wins || 0) + " L: " + (d.losses || 0) + " | Goals: " + (d.goals || 0) + " | Streak: " + (d.winStreak || 0), player.id, level.color, "normal");
              return;
            }
          }
          room.sendAnnouncement(msg(player.id, "playerNotFound", { name: targetName }), player.id, 0xFF0000);
        });
        return false;
      }

      if (message.substring(0, 2) === "@@") {
        var rest = message.substring(2);
        var spaceIdx = rest.indexOf(" ");
        if (spaceIdx > 0) {
          var targetName = rest.substring(0, spaceIdx);
          var pmText = rest.substring(spaceIdx + 1);
          var target = allPlayers().filter(function (p) { return p.name.toLowerCase() === targetName.toLowerCase(); })[0];
          if (target) {
            room.sendAnnouncement(msg(player.id, "pmFrom", { name: player.name, msg: pmText }), target.id, 0xE066FF, "normal");
            room.sendAnnouncement(msg(player.id, "pmTo", { name: target.name, msg: pmText }), player.id, 0xE066FF, "normal");
          } else {
            room.sendAnnouncement(msg(player.id, "playerNotFound", { name: targetName }), player.id, 0xFF0000);
          }
        }
        return false;
      }

      if (message.length > 2 && message.substring(0, 2).toLowerCase() === "t " ) {
        var team = player.team;
        var recipients;
        var teamName;
        if (team === 1) {
          recipients = redTeam; teamName = "🔴";
        } else if (team === 2) {
          recipients = blueTeam; teamName = "🔵";
        } else {
          recipients = queue; teamName = "👀";
        }
        var text = teamName + " [TEAM] " + player.name + ": " + message.substring(2);
        for (var i = 0; i < recipients.length; i++) {
          room.sendAnnouncement(text, recipients[i], 0xFFFF00, "normal");
        }
        return false;
      }

      if (message.toLowerCase() === "!afk") {
        if (afkPlayers[player.id]) {
          delete afkPlayers[player.id];
          broadcast("afkOff", { name: player.name }, 0x00FF00, "normal");
          setTimeout(organize, 0);
        } else {
          afkPlayers[player.id] = true;
          // Move to queue if on a team
          if (redTeam.indexOf(player.id) !== -1 || blueTeam.indexOf(player.id) !== -1) {
            removeFromTeam(player.id);
            addToQueue(player.id);
          }
          broadcast("afkOn", { name: player.name }, 0xFF7B08, "normal");
          setTimeout(organize, 0);
        }
        return false;
      }

      // Slow mode during picks (non-captains)
      if (picking) {
        var current = pickOrder[pickIndex];
        var isCaptain = current && player.id === current.captain;

        if (!isCaptain) {
          if (slowModeSet[player.id]) return false;
          slowModeSet[player.id] = true;
          setTimeout(function () { delete slowModeSet[player.id]; }, SLOW_MODE_DURING_PICKS);
        } else {
        // Captain pick logic
        var pickMsg = message.toLowerCase().trim();
        var pickedId = null;
        var availQueue = [];
        for (var i = 0; i < queue.length; i++) {
          if (isEligible(queue[i])) availQueue.push(queue[i]);
        }
        if (availQueue.length === 0) { finishPicking(); return false; }

        if (pickMsg === "top") {
          pickedId = availQueue[0];
        } else if (pickMsg === "bottom") {
          pickedId = availQueue[availQueue.length - 1];
        } else if (pickMsg === "random" || pickMsg === "rand") {
          pickedId = availQueue[Math.floor(Math.random() * availQueue.length)];
        } else {
          var num = parseInt(message);
          if (isNaN(num) || num < 1 || num > availQueue.length) {
            room.sendAnnouncement(msg(player.id, "invalidPick", { max: availQueue.length }), player.id, 0xFF0000);
            return false;
          }
          pickedId = availQueue[num - 1];
        }

        var picked = room.getPlayer(pickedId);
        setPlayerToTeam(pickedId, current.team);
        var teamName = current.team === 1 ? "Red" : "Blue";
        broadcast("joins", { name: picked ? picked.name : "", team: teamName }, 0x00FF00, "bold");

        pickIndex++;

        // Auto-assign last player if only 1 available left and picks remain
        if (availableQueueCount() === 1 && pickIndex < pickOrder.length) {
          var lastId = firstAvailableInQueue();
          var lastP = room.getPlayer(lastId);
          var lastTeam = pickOrder[pickIndex].team;
          setPlayerToTeam(lastId, lastTeam);
          var ln = lastTeam === 1 ? "Red" : "Blue";
          broadcast("joins", { name: lastP ? lastP.name : "", team: ln }, 0x00FF00, "bold");
          pickIndex = pickOrder.length;
        }

        if (pickIndex >= pickOrder.length || availableQueueCount() === 0) {
          finishPicking();
        } else {
          startPickPhase();
        }
        return false;
        } // end captain pick
      }

      // Normal chat — format with rank emoji, position, elo, character, name
      var auth = playerAuths[player.id];
      if (auth) {
        dbGetPlayer(auth).then(function (p) {
          var elo = (p && p.elo) ? p.elo : ELO_START;
          var level = getLevel(elo);
          var pos = playerRanks[auth] ? "#" + playerRanks[auth] : "";
          var prefix = playerRanks[auth] === 1 ? "GOAT " : "";
          var charKey = getPlayerCharacter(player.id);
          var charTag = CHARACTERS[charKey] ? "[" + CHARACTERS[charKey].name + "]" : "";
          var isAdmin = player.admin;
          var adminTag = isAdmin ? "[ADMIN] " : "";
          var color = isAdmin ? 0xFF8800 : level.color;
          room.sendAnnouncement(adminTag + prefix + level.emoji + " [" + pos + "] [" + elo + "] " + charTag + " " + player.name + ": " + message, null, color, "normal");
        }).catch(function(e) {
          room.sendAnnouncement(player.name + ": " + message, null, 0xB8C4D0, "normal");
        });
      } else {
        var charKey = getPlayerCharacter(player.id);
        var charTag = CHARACTERS[charKey] ? "[" + CHARACTERS[charKey].name + "]" : "";
        var isAdmin = player.admin;
        var adminTag = isAdmin ? "[ADMIN] " : "";
        var color = isAdmin ? 0xFF8800 : 0xB8C4D0;
        room.sendAnnouncement(adminTag + "🌙 [1000] " + charTag + " " + player.name + ": " + message, null, color, "normal");
      }
      return false;
    };

    room.onPlayerActivity = function (player) {
      recordActivity(player.id);
    };

    room.onPlayerBallKick = function (player) {
      prevKicker = lastKicker;
      lastKicker = player;
      // +5% ult charge on any kick
      addUltCharge(player.id, 5);
      // Power shot buff
      if (buffs[player.id] && buffs[player.id].type === "power_shot") {
        var mult = buffs[player.id].multiplier;
        delete buffs[player.id];
        try {
          var ball = room.getDiscProperties(0);
          if (ball) {
            room.setDiscProperties(0, { xspeed: ball.xspeed * mult, yspeed: ball.yspeed * mult });
          }
        } catch(e) {}
        room.sendAnnouncement("🔥💥 POWER SHOT!", null, 0xFF6600, "bold");
      }
    };


    // --- ABILITIES ---
    var ABILITY_DEFS = {
      mine:       { cd: 10000 },
      blast:      { cd: 20000 },
      smoke:      { cd: 25000 },
      self_destruct: { cd: 30000 },
      dash:       { cd: 8000 },
      sprint:     { cd: 15000 },
      phase:      { cd: 25000 },
      wall:       { cd: 12000 },
      push:       { cd: 15000 },
      fortress:   { cd: 30000 },
      ice_patch:  { cd: 10000 },
      freeze_ray: { cd: 18000 },
      blizzard:   { cd: 35000 },
      power_shot: { cd: 12000 },
      pull:       { cd: 20000 },
      rocket:     { cd: 30000 },
      swap:       { cd: 12000 },
      blink:      { cd: 10000 },
      banish:     { cd: 30000 }
    };

    // Per-player state
    var cooldowns = {};        // playerId -> { abilityName: timestamp }
    var buffs = {};            // playerId -> { type: ..., until: ... }
    var phased = {};           // playerId -> until timestamp

    // Disc-based objects on field
    var mines = [];
    var walls = [];            // { discIdx, until, type }
    var trapped = {};          // playerId -> { x, y, until }
    var slowZones = [];        // { x, y, until, discIdx }

    var mineDiscStarts = { training: 1, x1: 9, x3: 9 };
    var mineCount = 0;
    // Wall discs start after mines in each stadium
    var wallDiscStarts = { training: 11, x1: 19, x3: 19 };
    var wallCount = 0;
    var MAX_WALLS_PER_MAP = { training: 15, x1: 50, x3: 50 };

    function isOnCooldown(pid, ability) {
      return cooldowns[pid] && cooldowns[pid][ability] && Date.now() < cooldowns[pid][ability];
    }

    function setCooldown(pid, ability) {
      if (!cooldowns[pid]) cooldowns[pid] = {};
      cooldowns[pid][ability] = Date.now() + ABILITY_DEFS[ability].cd;
    }

    function getNextWallDisc() {
      // Reuse expired walls first
      for (var i = 0; i < walls.length; i++) {
        if (Date.now() > walls[i].until) {
          try { room.setDiscProperties(walls[i].discIdx, { x: 0, y: 9999, radius: 0, cMask: 0, cGroup: 0 }); } catch(e) {}
          walls.splice(i, 1);
          i--;
        }
      }
      var maxWalls = MAX_WALLS_PER_MAP[currentMap] || 10;
      if (wallCount >= maxWalls) return -1;
      var idx = (wallDiscStarts[currentMap] || 19) + wallCount;
      wallCount++;
      return idx;
    }

    function distBetween(a, b) {
      var dx = a.x - b.x; var dy = a.y - b.y;
      return Math.sqrt(dx * dx + dy * dy);
    }

    function getMovementDir(p) {
      // Approximate direction from player disc velocity
      try {
        var props = room.getPlayerDiscProperties(p.id);
        if (props && (props.xspeed !== 0 || props.yspeed !== 0)) {
          var mag = Math.sqrt(props.xspeed * props.xspeed + props.yspeed * props.yspeed);
          return { x: props.xspeed / mag, y: props.yspeed / mag };
        }
      } catch(e) {}
      return { x: 1, y: 0 }; // default: right
    }

    function getNearestEnemy(p, players, maxDist) {
      var team = p.team;
      var nearest = null; var minD = maxDist || 9999;
      for (var i = 0; i < players.length; i++) {
        var o = players[i];
        if (!o.position || o.team === team || o.team === 0) continue;
        var d = distBetween(p.position, o.position);
        if (d < minD) { minD = d; nearest = o; }
      }
      return nearest;
    }

    function getNearestTeammate(p, players) {
      var nearest = null; var minD = 9999;
      for (var i = 0; i < players.length; i++) {
        var o = players[i];
        if (!o.position || o.id === p.id || o.team !== p.team) continue;
        var d = distBetween(p.position, o.position);
        if (d < minD) { minD = d; nearest = o; }
      }
      return nearest;
    }

    window.handleAbility = function(pid, slot) {
      if (!gameRunning) return;
      if (typeof slot !== "number" || slot < 1 || slot > 3) return;

      var p = room.getPlayer(pid);
      if (!p || !p.position || p.team === 0) return;

      var players = room.getPlayerList();

      var charKey = getPlayerCharacter(p.id);
      var char = CHARACTERS[charKey];
      var ability = char.slots[slot - 1];
      if (!ability) return;
      if (isOnCooldown(p.id, ability)) return;

      // Slot 3 = ultimate, requires full charge
      if (slot === 3) {
        if (!ultCharge[p.id] || ultCharge[p.id] < 100) return;
      }

      var executed = executeAbility(ability, p, players);
      if (executed) {
        setCooldown(p.id, ability);
        if (slot === 3) ultCharge[p.id] = 0;
      }
    };

    function executeAbility(ability, p, players) {
      switch (ability) {
        // --- BOMBER ---
        case "mine": {
          var slotIdx = -1;
          for (var i = 0; i < mines.length; i++) {
            if (mines[i].armTime === Infinity) { slotIdx = i; break; }
          }
          if (slotIdx === -1 && mineCount >= 10) return false;
          var discIdx;
          if (slotIdx >= 0) {
            discIdx = mines[slotIdx].discIdx;
            mines[slotIdx] = { x: p.position.x, y: p.position.y, placer: p.id, team: p.team, active: false, discIdx: discIdx, armTime: Date.now() + 1000 };
          } else {
            discIdx = mineDiscStarts[currentMap] + mineCount;
            mines.push({ x: p.position.x, y: p.position.y, placer: p.id, team: p.team, active: false, discIdx: discIdx, armTime: Date.now() + 1000 });
            mineCount++;
          }
          var mineColor = p.team === 1 ? 0xFF0000 : 0x0000FF;
          try { room.setDiscProperties(discIdx, { x: p.position.x, y: p.position.y, radius: 5, invMass: 0, color: mineColor, cMask: 0, cGroup: 0 }); } catch(e) {}
          room.sendAnnouncement("💣 " + p.name + " placed a mine!", null, 0xFF4444, "normal");
          return true;
        }
        case "blast": {
          var triggered = 0;
          for (var i = 0; i < mines.length; i++) {
            if (mines[i].placer === p.id && mines[i].armTime !== Infinity) {
              mines[i].active = true; // force activate
              // Check proximity NOW — explode
              var BLAST_RADIUS = 50;
              var MAX_FORCE = 12;
              for (var j = 0; j < players.length; j++) {
                var pl = players[j];
                if (!pl.position || pl.team === 0 || pl.team === p.team) continue;
                if (phased[pl.id] && Date.now() < phased[pl.id]) continue;
                var d = distBetween(pl.position, mines[i]);
                if (d < BLAST_RADIUS) {
                  var force = MAX_FORCE * (1 - d / BLAST_RADIUS);
                  var dx = pl.position.x - mines[i].x;
                  var dy = pl.position.y - mines[i].y;
                  var mag = Math.sqrt(dx * dx + dy * dy) || 1;
                  try { room.setPlayerDiscProperties(pl.id, { xspeed: (dx / mag) * force, yspeed: (dy / mag) * force }); } catch(e) {}
                  triggered++;
                }
              }
              try { room.setDiscProperties(mines[i].discIdx, { x: 0, y: 9999, radius: 0 }); } catch(e) {}
              // Push ball if nearby
              try {
                var ball = room.getDiscProperties(0);
                if (ball) {
                  var bd = distBetween(ball, mines[i]);
                  if (bd < BLAST_RADIUS) {
                    var bforce = MAX_FORCE * (1 - bd / BLAST_RADIUS);
                    var bdx = ball.x - mines[i].x;
                    var bdy = ball.y - mines[i].y;
                    var bmag = Math.sqrt(bdx * bdx + bdy * bdy) || 1;
                    room.setDiscProperties(0, { xspeed: ball.xspeed + (bdx / bmag) * bforce, yspeed: ball.yspeed + (bdy / bmag) * bforce });
                  }
                }
              } catch(e) {}
              mines[i].active = false; mines[i].armTime = Infinity;
            }
          }
          room.sendAnnouncement("💥 " + p.name + " detonated mines!" + (triggered > 0 ? " Caught " + triggered + "!" : ""), null, 0xFF4444, "bold");
          return true;
        }
        case "smoke": {
          var idx = getNextWallDisc();
          if (idx === -1) return false;
          // Ball-blocking disc (collides with ball but not players)
          try { room.setDiscProperties(idx, { x: p.position.x, y: p.position.y, radius: 18, invMass: 0, color: 0x888888, cMask: 1, cGroup: 1 }); } catch(e) {}
          walls.push({ discIdx: idx, until: Date.now() + 3000, type: "smoke" });
          room.sendAnnouncement("💨 " + p.name + " dropped smoke!", null, 0x888888, "normal");
          return true;
        }
        case "self_destruct": {
          var BLAST_RADIUS = 80;
          var MAX_FORCE = 15;
          for (var i = 0; i < players.length; i++) {
            var target = players[i];
            if (!target.position || target.team === 0 || target.team === p.team) continue;
            if (phased[target.id] && Date.now() < phased[target.id]) continue;
            var d = distBetween(target.position, p.position);
            if (d < BLAST_RADIUS) {
              var force = MAX_FORCE * (1 - d / BLAST_RADIUS);
              var dx = target.position.x - p.position.x;
              var dy = target.position.y - p.position.y;
              var mag = Math.sqrt(dx * dx + dy * dy) || 1;
              try { room.setPlayerDiscProperties(target.id, { xspeed: (dx / mag) * force, yspeed: (dy / mag) * force }); } catch(e) {}
            }
          }
          // Push ball too
          try {
            var ball = room.getDiscProperties(0);
            if (ball) {
              var bd = distBetween(ball, p.position);
              if (bd < BLAST_RADIUS) {
                var bforce = MAX_FORCE * (1 - bd / BLAST_RADIUS);
                var bdx = ball.x - p.position.x;
                var bdy = ball.y - p.position.y;
                var bmag = Math.sqrt(bdx * bdx + bdy * bdy) || 1;
                room.setDiscProperties(0, { xspeed: ball.xspeed + (bdx / bmag) * bforce, yspeed: ball.yspeed + (bdy / bmag) * bforce });
              }
            }
          } catch(e) {}
          // Stun self for 1s
          trapped[p.id] = { x: p.position.x, y: p.position.y, until: Date.now() + 1000 };
          room.sendAnnouncement("💀 " + p.name + " SELF-DESTRUCTED!", null, 0xFF4444, "bold");
          return true;
        }

        // --- SPEEDSTER ---
        case "dash": {
          var dir = getMovementDir(p);
          var newX = p.position.x + dir.x * 80;
          var newY = p.position.y + dir.y * 80;
          try { room.setPlayerDiscProperties(p.id, { x: newX, y: newY }); } catch(e) {}
          room.sendAnnouncement("⚡ " + p.name + " dashed!", null, 0xFFFF00, "normal");
          return true;
        }
        case "sprint": {
          buffs[p.id] = { type: "speed", multiplier: 1.5, until: Date.now() + 3000 };
          room.sendAnnouncement("💨 " + p.name + " is sprinting!", null, 0xFFFF00, "normal");
          return true;
        }
        case "phase": {
          phased[p.id] = Date.now() + 1500;
          room.sendAnnouncement("👻 " + p.name + " phased out!", null, 0xCCCCFF, "normal");
          return true;
        }

        // --- GUARDIAN ---
        case "wall": {
          var idx = getNextWallDisc();
          if (idx === -1) return false;
          var dir = getMovementDir(p);
          var wx = p.position.x + dir.x * 40;
          var wy = p.position.y + dir.y * 40;
          try { room.setDiscProperties(idx, { x: wx, y: wy, radius: 14, invMass: 0, color: 0x4488FF, cMask: 63, cGroup: 63 }); } catch(e) {}
          walls.push({ discIdx: idx, until: Date.now() + 4000, type: "wall" });
          room.sendAnnouncement("🛡️ " + p.name + " placed a wall!", null, 0x4488FF, "normal");
          return true;
        }
        case "push": {
          for (var i = 0; i < players.length; i++) {
            var o = players[i];
            if (!o.position || o.team === p.team || o.team === 0) continue;
            var d = distBetween(p.position, o.position);
            if (d < 50) {
              var dx = o.position.x - p.position.x;
              var dy = o.position.y - p.position.y;
              var mag = Math.sqrt(dx * dx + dy * dy) || 1;
              try { room.setPlayerDiscProperties(o.id, { xspeed: (dx / mag) * 8, yspeed: (dy / mag) * 8 }); } catch(e) {}
            }
          }
          // Push ball too
          try {
            var ball = room.getDiscProperties(0);
            if (ball && distBetween(p.position, ball) < 50) {
              var dx = ball.x - p.position.x; var dy = ball.y - p.position.y;
              var mag = Math.sqrt(dx * dx + dy * dy) || 1;
              room.setDiscProperties(0, { xspeed: (dx / mag) * 8, yspeed: (dy / mag) * 8 });
            }
          } catch(e) {}
          room.sendAnnouncement("💫 " + p.name + " pushed!", null, 0x4488FF, "bold");
          return true;
        }
        case "fortress": {
          var dir = getMovementDir(p);
          var placed = 0;
          for (var a = -1; a <= 1; a++) {
            var idx = getNextWallDisc();
            if (idx === -1) break;
            var angle = Math.atan2(dir.y, dir.x) + a * 0.5;
            var wx = p.position.x + Math.cos(angle) * 50;
            var wy = p.position.y + Math.sin(angle) * 50;
            try { room.setDiscProperties(idx, { x: wx, y: wy, radius: 12, invMass: 0, color: 0x4488FF, cMask: 63, cGroup: 63 }); } catch(e) {}
            walls.push({ discIdx: idx, until: Date.now() + 3000, type: "fortress" });
            placed++;
          }
          if (!placed) return false;
          room.sendAnnouncement("🏰 " + p.name + " built a fortress!", null, 0x4488FF, "bold");
          return true;
        }

        // --- FROST ---
        case "ice_patch": {
          var idx = getNextWallDisc();
          if (idx === -1) return false;
          try { room.setDiscProperties(idx, { x: p.position.x, y: p.position.y, radius: 6, invMass: 0, color: 0x88DDFF, cMask: 0, cGroup: 0 }); } catch(e) {}
          slowZones.push({ x: p.position.x, y: p.position.y, until: Date.now() + 5000, discIdx: idx, radius: 25, team: p.team });
          walls.push({ discIdx: idx, until: Date.now() + 5000, type: "ice" });
          room.sendAnnouncement("🧊 " + p.name + " placed ice!", null, 0x88DDFF, "normal");
          return true;
        }
        case "freeze_ray": {
          var enemy = getNearestEnemy(p, players, 40);
          if (!enemy) return false;
          trapped[enemy.id] = { x: enemy.position.x, y: enemy.position.y, until: Date.now() + 2000 };
          room.sendAnnouncement("❄️ " + p.name + " froze " + enemy.name + "!", null, 0x88DDFF, "bold");
          return true;
        }
        case "blizzard": {
          for (var i = 0; i < players.length; i++) {
            var o = players[i];
            if (o.team !== p.team && o.team !== 0 && o.position) {
              buffs[o.id] = { type: "slow", multiplier: 0.7, until: Date.now() + 3000 };
            }
          }
          room.sendAnnouncement("🌨️ " + p.name + " unleashed a blizzard!", null, 0x88DDFF, "bold");
          return true;
        }

        // --- STRIKER ---
        case "power_shot": {
          buffs[p.id] = { type: "power_shot", multiplier: 1.8, until: Date.now() + 2000 };
          room.sendAnnouncement("🔥 " + p.name + "'s next shot is powered up!", null, 0xFF6600, "normal");
          return true;
        }
        case "pull": {
          try {
            var ball = room.getDiscProperties(0);
            if (ball && distBetween(p.position, ball) < 100) {
              room.setDiscProperties(0, { x: p.position.x, y: p.position.y, xspeed: 0, yspeed: 0 });
              room.sendAnnouncement("🧲 " + p.name + " pulled the ball!", null, 0xFF6600, "bold");
              return true;
            }
          } catch(e) {}
          return false;
        }
        case "rocket": {
          try {
            var ball = room.getDiscProperties(0);
            if (ball && distBetween(p.position, ball) < 25) {
              var goalX = p.team === 1 ? 370 : -370; // toward opponent goal
              var dx = goalX - ball.x; var dy = 0 - ball.y;
              var mag = Math.sqrt(dx * dx + dy * dy) || 1;
              room.setDiscProperties(0, { xspeed: (dx / mag) * 15, yspeed: (dy / mag) * 15 });
              room.sendAnnouncement("🚀 " + p.name + " launched a ROCKET!", null, 0xFF6600, "bold");
              return true;
            }
          } catch(e) {}
          return false;
        }

        // --- TRICKSTER ---
        case "swap": {
          var mate = getNearestTeammate(p, players);
          if (!mate) return false;
          var px = p.position.x, py = p.position.y;
          try {
            room.setPlayerDiscProperties(p.id, { x: mate.position.x, y: mate.position.y });
            room.setPlayerDiscProperties(mate.id, { x: px, y: py });
          } catch(e) {}
          room.sendAnnouncement("🔄 " + p.name + " swapped with " + mate.name + "!", null, 0xCC66FF, "normal");
          return true;
        }
        case "blink": {
          var angle = Math.random() * Math.PI * 2;
          var dist = 40 + Math.random() * 80;
          var nx = p.position.x + Math.cos(angle) * dist;
          var ny = p.position.y + Math.sin(angle) * dist;
          try { room.setPlayerDiscProperties(p.id, { x: nx, y: ny }); } catch(e) {}
          room.sendAnnouncement("✨ " + p.name + " blinked!", null, 0xCC66FF, "normal");
          return true;
        }
        case "banish": {
          var enemy = getNearestEnemy(p, players, 80);
          if (!enemy) return false;
          var goalX = enemy.team === 1 ? -350 : 350; // send to THEIR goal line
          trapped[enemy.id] = { x: goalX, y: 0, until: Date.now() + 500 };
          try { room.setPlayerDiscProperties(enemy.id, { x: goalX, y: 0 }); } catch(e) {}
          room.sendAnnouncement("👻 " + p.name + " banished " + enemy.name + "!", null, 0xCC66FF, "bold");
          return true;
        }

        default: return false;
      }
    }

    room.onGameTick = function () {
      if (!gameRunning) return;

      var allP = room.getPlayerList();

      // --- Passive ult charge: +2% every 5s for players on field ---
      if (!this._ultTick) this._ultTick = 0;
      this._ultTick++;
      if (this._ultTick >= 300) { // 60fps * 5s
        this._ultTick = 0;
        for (var i = 0; i < allP.length; i++) {
          if (allP[i].team !== 0) addUltCharge(allP[i].id, 2);
        }
      }

      // --- Send HUD state to extensions every 0.5s ---
      if (!this._hudTick) this._hudTick = 0;
      this._hudTick++;
      if (this._hudTick >= 30) {
        this._hudTick = 0;
        for (var i = 0; i < allP.length; i++) {
          var pid = allP[i].id;
          var wsId = playerToWs[pid];
          if (!wsId) continue;
          var charKey = getPlayerCharacter(pid);
          var char = CHARACTERS[charKey];
          var now = Date.now();
          var cd1 = cooldowns[pid] && cooldowns[pid][char.slots[0]] ? Math.max(0, cooldowns[pid][char.slots[0]] - now) : 0;
          var cd2 = cooldowns[pid] && cooldowns[pid][char.slots[1]] ? Math.max(0, cooldowns[pid][char.slots[1]] - now) : 0;
          var charge = ultCharge[pid] || 0;
          wsSendToPlayer(wsId, { type: "hud", slots: [
            { name: char.slots[0], cd: Math.ceil(cd1 / 1000) },
            { name: char.slots[1], cd: Math.ceil(cd2 / 1000) },
            { name: char.slots[2], charge: charge }
          ]});
        }
      }

      // --- Mine detection ---
      for (var m = 0; m < mines.length; m++) {
        var mine = mines[m];
        if (!mine.active && mine.armTime !== Infinity && Date.now() >= mine.armTime) {
          mine.active = true;
          try { room.setDiscProperties(mine.discIdx, { radius: 0 }); } catch(e) {}
        }
        if (!mine.active) continue;
        for (var i = 0; i < allP.length; i++) {
          var pl = allP[i];
          if (!pl.position || pl.team === 0 || pl.team === mine.team) continue;
          if (phased[pl.id] && Date.now() < phased[pl.id]) continue;
          if (distBetween(pl.position, mine) < 20) {
            // Explode! Push all enemies in blast radius
            var BLAST_RADIUS = 50;
            var MAX_FORCE = 12;
            for (var j = 0; j < allP.length; j++) {
              var target = allP[j];
              if (!target.position || target.team === 0 || target.team === mine.team) continue;
              if (phased[target.id] && Date.now() < phased[target.id]) continue;
              var d = distBetween(target.position, mine);
              if (d < BLAST_RADIUS) {
                var force = MAX_FORCE * (1 - d / BLAST_RADIUS);
                var dx = target.position.x - mine.x;
                var dy = target.position.y - mine.y;
                var mag = Math.sqrt(dx * dx + dy * dy) || 1;
                try { room.setPlayerDiscProperties(target.id, { xspeed: (dx / mag) * force, yspeed: (dy / mag) * force }); } catch(e) {}
              }
            }
            room.sendAnnouncement("💥 Mine exploded!", null, 0xFF0000, "bold");
            // Push ball if nearby
            try {
              var ball = room.getDiscProperties(0);
              if (ball) {
                var bd = distBetween(ball, mine);
                if (bd < BLAST_RADIUS) {
                  var bforce = MAX_FORCE * (1 - bd / BLAST_RADIUS);
                  var bdx = ball.x - mine.x;
                  var bdy = ball.y - mine.y;
                  var bmag = Math.sqrt(bdx * bdx + bdy * bdy) || 1;
                  room.setDiscProperties(0, { xspeed: ball.xspeed + (bdx / bmag) * bforce, yspeed: ball.yspeed + (bdy / bmag) * bforce });
                }
              }
            } catch(e) {}
            try { room.setDiscProperties(mine.discIdx, { x: 0, y: 9999, radius: 0 }); } catch(e) {}
            mine.active = false; mine.armTime = Infinity;
            break;
          }
        }
      }

      // --- Slow zones (ice patches) ---
      for (var z = slowZones.length - 1; z >= 0; z--) {
        if (Date.now() > slowZones[z].until) { slowZones.splice(z, 1); continue; }
        for (var i = 0; i < allP.length; i++) {
          var pl = allP[i];
          if (!pl.position || pl.team === 0 || pl.team === slowZones[z].team) continue;
          if (phased[pl.id] && Date.now() < phased[pl.id]) continue;
          if (distBetween(pl.position, slowZones[z]) < slowZones[z].radius) {
            if (!buffs[pl.id] || buffs[pl.id].type !== "slow") {
              buffs[pl.id] = { type: "slow", multiplier: 0.5, until: Date.now() + 2000 };
            }
          }
        }
      }

      // --- Expire walls ---
      for (var w = walls.length - 1; w >= 0; w--) {
        if (Date.now() > walls[w].until) {
          try { room.setDiscProperties(walls[w].discIdx, { x: 0, y: 9999, radius: 0, cMask: 0, cGroup: 0 }); } catch(e) {}
          walls.splice(w, 1);
        }
      }

      // --- Hold trapped players ---
      for (var pid in trapped) {
        if (Date.now() > trapped[pid].until) {
          delete trapped[pid];
        } else {
          try {
            room.setPlayerDiscProperties(parseInt(pid), { x: trapped[pid].x, y: trapped[pid].y, xspeed: 0, yspeed: 0 });
          } catch(e) { delete trapped[pid]; }
        }
      }

      // --- Speed buffs/debuffs ---
      for (var pid in buffs) {
        var b = buffs[pid];
        if (Date.now() > b.until) { delete buffs[pid]; continue; }
        if (b.type === "slow" || b.type === "speed") {
          try {
            var props = room.getPlayerDiscProperties(parseInt(pid));
            if (props) {
              var speed = Math.sqrt(props.xspeed * props.xspeed + props.yspeed * props.yspeed);
              if (speed > 0) {
                var targetSpeed = speed * b.multiplier;
                var ratio = targetSpeed / speed;
                if ((b.type === "slow" && ratio < 1) || (b.type === "speed" && ratio > 1)) {
                  room.setPlayerDiscProperties(parseInt(pid), { xspeed: props.xspeed * ratio, yspeed: props.yspeed * ratio });
                }
              }
            }
          } catch(e) {}
        }
      }

      // --- Expire phased ---
      for (var pid in phased) {
        if (Date.now() > phased[pid]) delete phased[pid];
      }

      // Force draw at 7 minutes
      var scores = room.getScores();
      if (scores && scores.time >= DRAW_TIME_LIMIT) {
        handleDraw();
        return;
      }

      // Ball speed tracking
      var bp = room.getBallPosition();
      if (bp && lastBallPos) {
        var dx = bp.x - lastBallPos.x;
        var dy = bp.y - lastBallPos.y;
        ballSpeed = Math.sqrt(dx * dx + dy * dy) * 60 * 3.6 / 10; // rough km/h
      }
      lastBallPos = bp;

      // Red GK = lowest X, Blue GK = highest X
      var redDeepest = null, redX = Infinity;
      var blueDeepest = null, blueX = -Infinity;
      for (var i = 0; i < redTeam.length; i++) {
        var p = room.getPlayer(redTeam[i]);
        if (p && p.position) {
          if (p.position.x < redX) { redX = p.position.x; redDeepest = p.id; }
        }
      }
      for (var i = 0; i < blueTeam.length; i++) {
        var p = room.getPlayer(blueTeam[i]);
        if (p && p.position) {
          if (p.position.x > blueX) { blueX = p.position.x; blueDeepest = p.id; }
        }
      }
      if (redDeepest) gkTicks[redDeepest] = (gkTicks[redDeepest] || 0) + 1;
      if (blueDeepest) gkTicks[blueDeepest] = (gkTicks[blueDeepest] || 0) + 1;
    };

    room.onTeamGoal = function (team) {
      var speedStr = ballSpeed > 0 ? " | " + ballSpeed.toFixed(1) + " km/h" : "";
      if (lastKicker && lastKicker.team === team) {
        // +50% ult charge for scorer
        addUltCharge(lastKicker.id, 50);
        // +30% ult charge for assist (prev kicker, same team, different player)
        if (prevKicker && prevKicker.team === team && prevKicker.id !== lastKicker.id) {
          addUltCharge(prevKicker.id, 30);
        }
        var auth = playerAuths[lastKicker.id];
        if (auth) {
          dbGetPlayer(auth).then(function (p) {
            var data = p || { name: "", games: 0, goals: 0 };
            data.goals = (data.goals || 0) + 1;
            dbSavePlayer(auth, data);
          });
        }
        var players2 = room.getPlayerList();
        for (var j = 0; j < players2.length; j++) {
          if (players2[j].id !== 0) room.sendAnnouncement(msg(players2[j].id, "goalBy", { name: lastKicker.name }) + speedStr, players2[j].id, 0x00FF00, "bold");
        }
      } else if (lastKicker) {
        var auth = playerAuths[lastKicker.id];
        if (auth) {
          dbGetPlayer(auth).then(function (p) {
            var data = p || { name: "", games: 0, goals: 0, ownGoals: 0 };
            data.ownGoals = (data.ownGoals || 0) + 1;
            dbSavePlayer(auth, data);
          });
        }
        var players2 = room.getPlayerList();
        for (var j = 0; j < players2.length; j++) {
          if (players2[j].id !== 0) room.sendAnnouncement(msg(players2[j].id, "ownGoal", { name: lastKicker.name }) + speedStr, players2[j].id, 0xFF4444, "bold");
        }
      }
      lastKicker = null;
    };

    room.onTeamVictory = function (scores) {
      handleMatchEnd(scores);
    };

    room.onGameStop = function () { gameRunning = false; };
    room.onGameStart = function () {
      gameRunning = true;
      matchStartTime = Date.now();
      matchPlayers = redTeam.concat(blueTeam);
      gkTicks = {};
      // Reset ult charge for all players
      for (var i = 0; i < matchPlayers.length; i++) { ultCharge[matchPlayers[i]] = 0; }
      lastBallPos = null;
      ballSpeed = 0;
      mines = [];
      trapped = {};
      mineCount = 0;
      mineCooldowns = {};
    };

  }, TOKEN, stadiums, i18n);

  let link = null;
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    link = await page.evaluate(() => window.__roomLink);
    if (link) break;
  }

  if (link) {
    console.log("\n✅ Room is live!");
    console.log("🔗 " + link + "\n");
  } else {
    console.error("❌ Failed. Token likely expired.");
    await browser.close();
    process.exit(1);
  }

  process.on("SIGINT", async () => {
    console.log("\nShutting down...");
    await browser.close();
    process.exit(0);
  });
})();

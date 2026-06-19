# Haxball Headless Futsal Room — Requirements & Decisions

## 1. Overview & Vision

- **Goal**: Competitive futsal room with ranked 3v3
- **Philosophy**: 1v1 and 2v2 are unranked "filler" modes while waiting for enough players. 3v3 is the real competitive mode.
- **Core principle**: Teams must always be even. Never play with unbalanced sides.
- **Persistence**: JSON file (`data/players.json`) with merge-on-write. Interface in `db.js` designed for easy SQLite migration.

---

## 2. Game Modes

| Mode | Players per team | Stadium | Ranked |
|------|-----------------|---------|--------|
| Training | 1 (solo) | futsal-training | No |
| x1 (1v1 / 2v2) | 1–2 | futsal-x1 | No |
| x3 (3v3) | 3 | futsal-x3 | **Yes** |

- Mode determined automatically by active (non-AFK) player count
- Mode upgrades mid-match when enough players join
- Mode downgrades mid-match when players leave and can't be replaced

---

## 3. Match Rules

- **Score limit**: 3 (all modes)
- **Time limit**: 3 minutes (all modes)
- **Draw limit**: 7 minutes total — if no winner by 7 min, game declared draw, everyone to queue
- **Sudden death**: Native Haxball behavior — if tied at 3 min, game continues until next goal
- **Winner stays**: Winning team stays, losers go to back of queue
- **No win streak limit**: Winners stay indefinitely
- **5-second buffer**: After picks complete, wait 5 seconds before kickoff (fresh starts only, NOT mid-match replacements)
- **3-second victory screen**: After match ends, wait 3 seconds (victory screen), then stop game and reorganize

---

## 4. Pick System

### Post-match (challenger team formation)
1. Losers go to queue
2. First available (non-AFK) from queue fills the empty team, one by one
3. If team size > 1 and multiple spots need filling: captain picks
4. After picks → 5-second wait → game starts

### Captain order
- Each team maintains an ordered list of players (join order)
- Captain = first in list
- If captain leaves, next player in list becomes captain

### Pick commands (captain only)
- Number (1, 2, 3...) — pick by position in list
- `top` — pick first in queue
- `bottom` — pick last in queue
- `random` / `rand` — pick random from queue

### Pick timeout
- 20 seconds to pick
- Warning at 13 seconds ("7 seconds left!")
- Kicked if timeout expires

### Slow mode during picks
- Non-captains have 2-second chat cooldown during pick phase
- Captain messages pass through immediately

### Mid-match replacement picks
- Game pauses
- Captain picks replacement from queue
- Game resumes immediately (no 5-second wait)

### AFK players during picks
- AFK players are NOT shown in the pick list
- AFK players cannot be picked
- Only non-AFK queue members are pickable

---

## 5. Mode Transitions

**Key rule**: Any mode change = stop game → change stadium → restart game.

### Upgrade (more players join, not during picks)
- `organizeUpgrade()`: stop game, change map, keep existing teams, captains pick remaining from queue, 5s wait, start

### Upgrade during active picks
- `refreshPickPhase()`: update map if threshold crossed, recalculate needs, rebuild pick order, resend list to captain. Picks are NEVER cancelled — they continue with updated state.

### Mid-match fill (same map, team size increases)
- `organizeMidMatchFill()`: pause game, captain picks (or auto-assign if 1 spot), resume

### Downgrade (players leave, can't be replaced)
- `organizeDowngrade()`: rebalance with available players, change map if needed, restart in lower mode

---

## 6. Edge Cases — Mid-Match Leaves

### During pick phase
| Case | What happens |
|------|-------------|
| Captain leaves | Next in team list becomes captain, inherits pick, list resent |
| Queued player leaves | Pick list refreshes, picks continue |
| Non-captain team member leaves | `refreshPickPhase()` recalculates needs |

### During game
| Case | What happens |
|------|-------------|
| Entire team leaves | Instant forfeit, other team wins |
| Ragequit (after 75% time, losing by 2+, can't replace) | Automatic win for other team |
| Player leaves, queue can fill | `organize()` fills from queue |
| Player leaves, queue empty | Downgrade to lower mode |
| Valid 1v1 remains after leaves | Game continues uninterrupted |

### After match (winner stays)
| Case | What happens |
|------|-------------|
| Queue has enough players | Fill empty team from queue, start new game |
| Queue doesn't have enough | Downgrade to mode available players support |
| Everyone leaves except 1 | Training mode |

---

## 7. ELO / Ranking System

### Basics
- **Only 3v3 is ranked**
- **Starting ELO**: 1000
- **K-factor**: 32
- **Formula**: Individual player ELO vs opponent team average
  - `Expected = 1 / (1 + 10^((OpponentTeamAvg - YourELO) / 400))`
  - `Change = K * (Result - Expected)`
- Lower-rated players gain more on win, higher-rated gain less (natural Elo behaviour)
- ELO awarded to everyone on a team at match end (includes mid-match replacements)
- Both teams must have 3 players at match end for ELO to apply

### Leave penalties (3v3 only)
| Timing | Leaver penalty |
|--------|---------------|
| 0–10s | Nothing |
| After 10s | -25 ELO, +1 game, +1 loss |

Other players are NOT affected by a leaver's penalty.

### Levels (34 tiers)

| ELO Range | Name | Emoji | Color |
|-----------|------|-------|-------|
| 2000+ | God | 👁️ | 0xFF4500 |
| 1900–1999 | Immortal | 🛡️ | 0xFF6347 |
| 1800–1899 | Legend | 🏆 | 0xFFD700 |
| 1700–1799 | Mythic | 🐉 | 0xDA70D6 |
| 1650–1699 | Diamond | 💎 | 0xB9F2FF |
| 1600–1649 | Champion | 💠 | 0x7DF9FF |
| 1550–1599 | Master | 🌟 | 0xFFE066 |
| 1500–1549 | Star | ⭐ | 0xFFC800 |
| 1450–1499 | Inferno | 🔥 | 0xFF8C00 |
| 1400–1449 | Blaze | 🌶️ | 0xE8530E |
| 1350–1399 | King | 👑 | 0xF0C040 |
| 1300–1349 | Knight | 🦁 | 0xD4A020 |
| 1250–1299 | Thunder | ⚡ | 0xCDA0F7 |
| 1200–1249 | Elite | 🎯 | 0x40E0D0 |
| 1150–1199 | Platinum | 🥇 | 0xA0E6A0 |
| 1100–1149 | Gold | 🪙 | 0xD4AF37 |
| 1050–1099 | Silver | 🥈 | 0xC0C0C0 |
| 1000–1049 | Moon | 🌙 | 0xE8E8E8 |
| 950–999 | Bronze | 🥉 | 0xCD7F32 |
| 900–949 | Copper | 🔶 | 0xB87333 |
| 850–899 | Iron | ⛏️ | 0xA0A0A0 |
| 800–849 | Tin | 🔧 | 0x8C8C8C |
| 750–799 | Stone | 🪨 | 0x808080 |
| 700–749 | Clay | 🧱 | 0xA0522D |
| 650–699 | Slug | 🐌 | 0x7A8B50 |
| 600–649 | Worm | 🐛 | 0x6B8E23 |
| 550–599 | Turtle | 🐢 | 0x4E8B4E |
| 500–549 | Egg | 🥚 | 0x9B9B6B |
| 450–499 | Ice | 🧊 | 0x6BA3BE |
| 400–449 | Frost | ❄️ | 0x5B8FA8 |
| 350–399 | Coffin | ⚰️ | 0x6B4E4E |
| 300–349 | Ghost | 👻 | 0x7B6B8E |
| 250–299 | Skull | 💀 | 0x6B6B6B |
| <250 | Void | 🕳️ | 0x505050 |

### Level up notifications
- Announced to everyone when a player crosses a tier boundary upward

### Player avatar
- Set to character emoji on join and after character change

### Leaderboard
- Cached in memory (`playerRanks` map: auth → position)
- Recalculated on room start and after any ELO change
- Position shown in chat messages
- #1 player gets "GOAT" prefix

---

## 8. Stats Tracked (per player in DB)

| Field | Description |
|-------|-------------|
| name | Last known player name |
| elo | Current ELO rating |
| games | Total games finished |
| wins | Games won |
| losses | Games lost |
| draws | Games drawn (7-min timeout) |
| goals | Goals scored |
| ownGoals | Own goals |
| cleanSheets | Games as GK with 0 conceded |
| winStreak | Current consecutive wins |
| bestStreak | All-time best win streak |

### Goalkeeper detection
- Time-weighted position tracking via `onGameTick`
- Player who spent >50% of ticks as deepest on their team = GK
- Clean sheet awarded if GK's team concedes 0

---

## 9. Chat System

### Message format
```
GOAT 🏆 [#1] [1824] PlayerName: message here
```
- GOAT prefix (only for #1)
- Rank emoji
- Leaderboard position
- ELO
- Player name
- Message
- Color = rank color

### Team chat
- `t <message>` — sends only to teammates (or queue if spectating)
- Red team: 🔴 prefix, Blue: 🔵, Queue: 👀

### Private messages
- `@@PlayerName message` — sends to that player only

---

## 10. Commands

| Command | Description |
|---------|-------------|
| `!help` | List all commands |
| `!stats` | Show your stats (private) |
| `!top` | Top 5 by ELO (private) |
| `!streak` | Your current and best win streak (private) |
| `!rank <name>` | Check any player's stats by name (private) |
| `!queue` | Show queue (excludes AFK players, private) |
| `!afk` | Toggle AFK status |
| `!bb` | Leave room |
| `!admin futsalzinho99` | Grant admin (hidden) |

---

## 11. AFK System

### Voluntary AFK (`!afk`)
- Player stays in queue, advances naturally
- Skipped by all auto-assign logic
- Not shown in pick lists, cannot be picked
- Can sit at #1 indefinitely until they un-AFK
- Un-AFK triggers organize if needed

### Inactivity AFK (currently disabled for testing)
- 4 seconds no movement/chat → warning
- 4 more seconds → kicked
- Only checked for players on teams during a game

---

## 12. Anti-abuse

### Spam protection
- 5+ messages in 3 seconds = kicked

### Ragequit detection
- Game past 75% of time limit + team losing by 2+ goals + player leaves + can't replace = automatic win for other team

### Pick timeout
- 20 seconds or get kicked

---

## 13. Persistence

### Architecture
- `db.js` — clean interface (getPlayer, savePlayer, getAllPlayers, etc.)
- `data/players.json` — player records keyed by auth token
- `savePlayer` uses **merge** (not overwrite) — safe for concurrent async writes
- Designed for easy SQLite migration (swap `db.js` internals, keep interface)

### What we DON'T persist
- Match history (decided against — all stats on player records)
- Queue state (ephemeral)
- Room state (ephemeral)

---

## 14. Architecture (code structure)

### `room.js` — single file, runs in `page.evaluate()`
Split into focused functions:
- `organize()` — entry point, routes to sub-functions
- `organizeEmpty/Training/1v1` — specific player count handlers
- `trimTeams` / `balanceTeamsFromQueue` / `ensureCaptains` — team management
- `organizeDowngrade` / `organizeAutoAssign` / `organizeStartPicks` — fill strategies
- `organizeMidMatchFill` / `organizeUpgrade` / `refreshPickPhase` — mid-game changes
- `handleMatchEnd` / `handleDraw` — end-of-game logic
- `startPickPhase` / `finishPicking` / `buildPickOrder` — pick system
- `refreshLeaderboard` / `getLevel` — ELO/ranking

### `db.js` — persistence layer
### `i18n.js` — translations (EN/PT, not yet wired to all strings)

---

## 15. Internationalization

- `i18n.js` has EN and PT translations
- Default language: PT (Portuguese room)
- `t(playerId, key, vars)` for player-specific messages
- `tb(key, vars)` for broadcasts
- Infrastructure ready, not all strings migrated yet

---


## 16. Abilities System (Browser Extension)

### Architecture
- **Browser extension** (Firefox/Chrome) captures configurable key presses (default: 1, 2, 3) on the Haxball game page
- Extension sends slot number via WebSocket to the room server (port 4200)
- Each WebSocket connection is mapped to a unique player ID on identify (prevents name collision issues)
- Room server resolves player ID + character → ability and executes it
- Abilities manipulate discs, player positions, and game state
- Keys are ignored when chat input is focused (no accidental triggers while typing)

### Character System
Players choose a character with `!char <name>`. Each character has 3 abilities bound to slots 1/2/3. Character persists to DB and is restored on rejoin. Player avatar is set to character emoji. Chat messages show `[CharacterName]` tag.

| Character | Emoji | Slot 1 (basic) | Slot 2 (tactical) | Slot 3 (ULTIMATE) |
|-----------|-------|--------|--------|--------|
| Bomber | 🧨 | Mine (explosive trap, 10s) | Blast (detonate all mines, 20s) | Self-Destruct (80u AoE explosion, stuns self 1s, 30s) |
| Speedster | ⚡ | Dash (teleport 80u forward, 8s) | Sprint (+50% speed 3s, 15s) | Phase (untouchable 1.5s, 25s) |
| Guardian | 🛡️ | Wall (solid disc 4s, 12s) | Push (knockback nearby enemies + ball, 15s) | Fortress (3-disc barricade 3s, 30s) |
| Frost | 🧊 | Ice Patch (slow zone 5s, enemies only, 10s) | Freeze Ray (freeze nearest enemy 2s, range 40u, 18s) | Blizzard (slow ALL enemies 3s, 35s) |
| Striker | 🔥 | Power Shot (+80% ball speed on next kick, 12s) | Pull (yank ball to you within 100u, 20s) | Rocket (launch ball at goal, must touch, 30s) |
| Trickster | 👻 | Swap (switch pos with nearest teammate, 12s) | Blink (random teleport within 120u, 10s) | Banish (send nearest enemy to their goal, 30s) |

### Ultimate Charge System
Slot 3 abilities are **ultimates** — they require 100% charge earned through gameplay (not a flat cooldown):

| Action | Charge |
|--------|--------|
| Kick ball | +5% |
| Score a goal | +50% |
| Assist (prev kicker, same team) | +30% |
| Time on field | +2% every 5 seconds |

- Charge resets to 0% at game start
- When 100% reached, announced to all: "⚡ PlayerName's ULTIMATE is ready!"
- Using slot 3 consumes all charge (resets to 0%)
- Slot 3 blocked until fully charged

### Mine Mechanics
- Mines show in team color (red/blue) for 1 second, then turn invisible
- Only enemies trigger mines (teammates walk through safely)
- Mines explode with knockback: 50u blast radius, force decreases with distance (max 12)
- Ball is also pushed by mine explosions if within blast radius
- Max 10 active mines on field at once
- Blast (slot 2) detonates all your mines simultaneously

### Ability Effects — Enemies Only
All offensive abilities only affect the opposing team:
- Mines: only triggered by enemies
- Ice Patch: only slows enemies
- Freeze Ray: only targets enemies
- Blizzard: only slows enemies
- Push: only pushes enemies
- Banish: only targets enemies
- Self-Destruct: only pushes enemies (stuns self)

### Extension Detection
- Extension sends `identify` message on connect, server maps WebSocket → player ID
- If no identify received within 5 seconds of joining, player gets warning with install link
- Warning message: "⚠️ Extension not detected! Install it: github.com/Dzithi/haxball-abilities"

### Technical Details
- Mine discs pre-loaded in stadium files (10 hidden discs per stadium, offscreen)
- Disc indices per map: training mines=1-10, x1/x3 mines=9-18
- Wall/zone discs: training=15 slots (idx 11-25), x1/x3=50 slots (idx 19-68)
- Ice Patch: visual disc radius 6 (small dot), detection radius 25 (server-side)
- Speed buffs/debuffs applied per-tick by scaling player velocity
- Phase makes players immune to mines, ice patches, freeze ray
- All disc operations wrapped in try-catch to prevent crashes
- No disc transparency in HaxBall — discs render above players

### Extension Files
- `extension/` — Chrome (Manifest V3) with popup for key rebinding
- `extension-firefox/` — Firefox (Manifest V2, signed via AMO)
- Firefox download: https://addons.mozilla.org/firefox/downloads/file/4858302/3bc1525dc71b41c0885d-2.0.xpi
- Chrome download: https://github.com/Dzithi/haxball-abilities/releases/latest/download/haxball-abilities-chrome.zip
- Content script ignores keypresses when chat input is focused
- Extension popup allows reassigning which keys trigger slots 1/2/3 (default: 1, 2, 3)
- GitHub repo: https://github.com/Dzithi/haxball-abilities

### Commands
| Command | Description |
|---------|-------------|
| `!char` | Show current character and available list |
| `!char <name>` | Pick a character |
| `!feedback <msg>` | Submit feedback (saved to data/feedback.json) |
| `!showfeedback` | Show unresolved feedback (admin only, private) |
| `!resolve <num>` | Resolve a feedback item (admin only) |

### Limits & Considerations
- ~128 total discs per stadium (ball + players + stadium + ability discs)
- Training: 25 total discs, x1/x3: 68 total discs — well within 128 limit
- Wall discs auto-expire and recycle indices
- Speed buff/debuff applied per-tick via velocity scaling

---

## 17. Future Work

- [ ] More characters with unique ability sets
- [ ] Ability cooldown/charge UI overlay in the extension
- [ ] Per-character balance tuning (cooldowns, ranges, durations)
- [ ] Geo-IP language detection (decode player.conn → country.is API)
- [ ] Admin commands (!mute, !kick, !ban)
- [ ] Welcome back message with rank for returning players
- [ ] ELO decay for inactive players
- [ ] Placement matches (higher K-factor for first 5 games)
- [ ] Move to dedicated server with pm2 for auto-restart

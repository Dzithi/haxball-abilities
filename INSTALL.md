# ⚡ Haxball Abilities — Extension Install Guide

## Firefox

1. Download the extension: [haxball-abilities.xpi](https://github.com/shashuke/haxball-abilities/releases/latest/download/haxball-abilities.xpi)
2. Open the file — Firefox will ask to install it
3. Click **Add**
4. Done! The ⚡ icon appears in your toolbar

## Chrome / Edge / Brave

1. Download and unzip: [haxball-abilities-chrome.zip](https://github.com/shashuke/haxball-abilities/releases/latest/download/haxball-abilities-chrome.zip)
2. Open `chrome://extensions/` (or `edge://extensions/` / `brave://extensions/`)
3. Enable **Developer mode** (toggle top-right)
4. Click **Load unpacked**
5. Select the unzipped folder
6. Done! The ⚡ icon appears in your toolbar

> ⚠️ Chrome will show a popup on startup asking to disable developer extensions. Just dismiss it — the extension works fine.

## Configure Keys

Click the ⚡ icon in your toolbar to open the key binding popup. Default keys are **1**, **2**, **3** for abilities 1, 2, 3. Change them to whatever you prefer.

## Pick Your Character

In the room, type `!char` to see available characters, then `!char <name>` to pick one:

| Character | Abilities |
|-----------|-----------|
| 🧨 Bomber | Mine, Blast, Smoke |
| ⚡ Speedster | Dash, Sprint, Phase |
| 🛡️ Guardian | Wall, Push, Fortress |
| 🧊 Frost | Ice Patch, Freeze Ray, Blizzard |
| 🔥 Striker | Power Shot, Pull, Rocket |
| 👻 Trickster | Swap, Blink, Banish |

## Troubleshooting

- **Extension not detected?** Make sure the room server is running on your network (WebSocket port 4200)
- **Keys not working?** Click inside the game area first — the extension only captures keys when Haxball is focused

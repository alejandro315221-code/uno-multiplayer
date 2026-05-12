# 🎲 Tabletop Online

Tabletop Online is a browser-based multiplayer table room for friends. Create a room, invite players with a room code, add CPU opponents, chat, and play several lightweight table games from the same lobby.

## Features

- **Real-time multiplayer rooms** over WebSockets.
- **Host-selected game menu** after players join.
- **Game modes:**
  - Crazy Eights with a standard 52-card deck
  - Blackjack with chips
  - Texas Hold'em
  - Bingo with Easy and Hard draw modes
  - Left Center Right
  - Roulette with American/European tables and play-money chip betting
  - Bank Dice, a family-friendly craps-rules dice table
  - Punto Banco Baccarat with automated third-card rules
  - Chat Room mode
- **CPU players** for filling empty seats.
- **Room chat** with optional profanity filtering and host chat clearing.
- **Family/school-friendly default:** casino and betting games are hidden unless the host turns on the opt-in gambling-games switch.
- **Music/SFX controls** and a launch screen that captures a user click so browsers can allow startup audio.
- **No real-money transaction logic:** casino-style games use only local virtual chip balances and never connect to payment, card-processing, cryptocurrency, or cash-out systems.
- **No database required** for basic play; rooms live in server memory.

## Quick Start

```bash
npm install
npm start
```

Then open:

```text
http://localhost:3000
```

## How to Play

1. Open the site.
2. Click **Launch Tabletop Online!**.
3. Enter your name and a room code.
4. Share the same URL and room code with friends.
5. The first player in the room is the host.
6. The host picks a game, adds CPUs if desired, and starts the table.

## Deployment Notes

This is a Node.js web service. For hosts such as Render, Railway, or similar platforms, use:

| Setting | Value |
|---|---|
| Runtime | Node |
| Build command | `npm install` |
| Start command | `npm start` |
| Root directory | repository root |

The server listens on `process.env.PORT` when provided by the hosting platform, and falls back to `3000` locally.

## Audio Assets

The client references optional audio files such as:

- `startup-sound.mp3`
- `card-table-swing.mp3`
- `in-the-lobby.mp3`
- `pass-the-chips.mp3`
- `game-in-progress.mp3`
- `dealing-the-cards.mp3`

If these files are not present, gameplay still works, but those audio tracks will not play. Add your own licensed/royalty-free files with those names in the repo root if you want music and startup audio.

## Talking AI CPUs

CPU players have named personalities and can speak in chat. There are two layers:

- **Always available:** deterministic bot quips after CPU moves.
- **Optional Groq mode:** if `GROQ_API_KEY` is set on the server, human chat in a room with CPUs has a 30% chance to trigger one of the active CPUs. Mentioning a CPU by name, such as "Grog" or "Nova," makes that specific CPU more likely to respond using `llama-3.1-8b-instant`.

Current CPU personalities are:

| CPU | Personality |
|---|---|
| Grog | Aggressive, sarcastic fantasy barbarian roast master |
| Juno | Over-enthusiastic ALL-CAPS hype-man |
| Blitz | Impatient speed-runner who wants every turn faster |
| Nova | Ultra-polite calculation android with win-probability analysis |
| Pixel | Retro arcade nerd with 8-bit slang and cheat-code references |
| Zed | Anxious paranoid doom-scroller convinced the game is rigged |
| Ace | Smooth, flirtatious card shark and casino high-roller |
| Riff | Chill rocker dude comparing moves to music and guitar solos |
| Echo | Sarcastic copycat mirror using fragments and SpOnGeBoB-style mockery |

For hosted deployments, store API keys only as environment variables, never in the repo:

| Variable | Purpose |
|---|---|
| `GROQ_API_KEY` | Enables Groq-powered CPU chat responses |
| `GROQ_MODEL` | Optional override; defaults to `llama-3.1-8b-instant` |

The server keeps a short sliding room conversation history and throttles AI replies so chat does not spam the API.

## Project Files

| File | Purpose |
|---|---|
| `server.js` | HTTP/WebSocket server and authoritative game logic |
| `uno.html` | Browser client UI served by the server |
| `profanity-list.js` | Chat profanity word list |
| `favicon.svg` | Browser favicon |
| `package.json` | Node scripts and dependencies |

## Development Checks

```bash
node --check server.js
python3 - <<'PY'
from pathlib import Path
html = Path('uno.html').read_text()
Path('/tmp/uno-inline.js').write_text(html[html.index('<script>') + len('<script>'):html.rindex('</script>')])
PY
node --check /tmp/uno-inline.js
```

# 🎴 UNO Multiplayer

A real-time multiplayer UNO game. You host, your friends join from their browsers.

---

## Quick Start (Local)

```bash
npm install
npm start
# Open http://localhost:3000 in your browser
```

---

## Host Online (Free — pick one)

### Option A: Railway (Recommended — easiest)
1. Push this folder to a GitHub repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Railway auto-detects Node.js and deploys
4. Click "Generate Domain" → share the URL with friends

### Option B: Render
1. Push to GitHub
2. Go to [render.com](https://render.com) → New Web Service → Connect repo
3. Build command: `npm install`  |  Start command: `npm start`
4. Share the `.onrender.com` URL

### Option C: Replit
1. Go to [replit.com](https://replit.com) → Create Repl → Upload files
2. Click Run → share the Repl URL

---

## How to Play

1. **You** open the URL, type your name + a room code (e.g. `PIZZA`), press Join
2. Share the URL + room code with friends — they do the same
3. **As host** (first to join), click **Start Game** once everyone is in
4. Up to **6 players** per room
5. Friends can rejoin using the same name if they disconnect

---

## Rules (standard UNO)

| Card  | Effect |
|-------|--------|
| Number | Match by color or number |
| **S** (Skip) | Next player loses their turn |
| **R** (Reverse) | Direction flips |
| **+2** | Next player draws 2, loses turn |
| **W** (Wild) | Play anytime, choose new color |
| **+4** (Wild Draw Four) | Next player draws 4, loses turn |

- Draw a card if you can't (or don't want to) play
- After drawing, you may play the drawn card if it matches
- First player to empty their hand wins!

---

## Files

| File | Purpose |
|------|---------|
| `server.js` | Node.js WebSocket + HTTP server (game authority) |
| `uno.html` | Browser client (served by server) |
| `package.json` | Node dependencies (`ws` only) |

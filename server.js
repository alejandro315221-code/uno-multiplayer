const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const PROFANITY_LIST = require('./profanity-list');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 10;

const SUITS = ['Spades', 'Hearts', 'Diamonds', 'Clubs'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

const httpServer = http.createServer((req, res) => {
  const filePath = path.join(__dirname, req.url === '/' ? 'uno.html' : req.url);
  fs.readFile(filePath, (err, data) => {
    if (err) return res.writeHead(404).end('Not found');
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
      '.png': 'image/png', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg',
      '.ogg': 'audio/ogg', '.wav': 'audio/wav'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });
const rooms = {};

function makeRoom(code) {
  return {
    code,
    players: [],
    state: 'lobby',
    gameType: 'crazy_eights',
    chatFilterEnabled: false,
    hostCanClearChat: false,
    gameplayMusicEnabled: false,

    // game data
    ce: null,
    bingo: null,
    bj: null
  };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function broadcast(room, msg) {
  room.players.forEach(p => {
    if (p.ws && p.ws.readyState === 1) p.ws.send(JSON.stringify(msg));
  });
}

function sendChat(room, from, text) {
  let safe = String(text || '');
  if (room.chatFilterEnabled && from !== 'Server') {
    for (const w of PROFANITY_LIST) safe = safe.replace(new RegExp(`\\b${w}\\b`, 'gi'), m => '*'.repeat(m.length));
  }
  broadcast(room, { type: 'chat', from, text: safe });
}

function lobbyPayload(room) {
  return {
    type: 'lobby',
    players: room.players.map(p => p.name),
    hostName: room.players[0]?.name || '',
    gameType: room.gameType,
    chatFilterEnabled: room.chatFilterEnabled,
    hostCanClearChat: room.hostCanClearChat,
    gameplayMusicEnabled: room.gameplayMusicEnabled,
    bjBettingEnabled: room.bj?.bettingEnabled ?? true,
    bingoAutoDrawEnabled: room.bingo?.autoDrawEnabled ?? true,
    bingoDrawIntervalSec: room.bingo?.drawIntervalSec ?? 10,
    bingoPaused: room.bingo?.paused ?? false
  };
}

/* ---------------- Crazy Eights ---------------- */
function ceBuildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit: s, rank: r });
  return shuffle(d);
}
function ceCanPlay(card, activeSuit, activeRank) {
  return card.rank === '8' || card.suit === activeSuit || card.rank === activeRank;
}
function ceDraw(room, n = 1) {
  const g = room.ce;
  const out = [];
  for (let i = 0; i < n; i++) {
    if (!g.deck.length) {
      if (g.discard.length <= 1) break;
      const top = g.discard.pop();
      g.deck = shuffle(g.discard);
      g.discard = [top];
    }
    if (g.deck.length) out.push(g.deck.pop());
  }
  return out;
}
function ceNextTurn(room) {
  const g = room.ce;
  const n = room.players.length;
  let idx = (g.turnIdx + 1) % n;

  let tries = 0;
  while (tries < n) {
    const p = room.players[idx];
    if (p && p.connected) break;
    idx = (idx + 1) % n;
    tries++;
  }

  g.turnIdx = idx;
  g.hasDrawn = false;

  // CPU turn trigger
  const cur = room.players[g.turnIdx];
  if (cur && cur.isBot) runCpuTurn(room);
}
function ceSendState(room) {
  const g = room.ce;
  const top = g.discard[g.discard.length - 1] || null;
  room.players.forEach((p, idx) => {
    if (!p.ws || p.ws.readyState !== 1) return;
    p.ws.send(JSON.stringify({
      type: 'state',
      gameType: 'crazy_eights',
      hand: p.hand || [],
      others: room.players.map((op, oi) => ({
        name: op.name, cardCount: (op.hand || []).length, isCurrentTurn: oi === g.turnIdx, isYou: oi === idx, connected: op.connected
      })),
      topCard: top,
      activeSuit: g.activeSuit,
      activeRank: g.activeRank,
      turnIdx: g.turnIdx,
      yourIdx: idx,
      deckCount: g.deck.length,
      hasDrawn: g.hasDrawn,
      state: room.state,
      winner: g.winner || null,
      gameplayMusicEnabled: room.gameplayMusicEnabled
    }));
  });
}
const cur = room.players[room.ce.turnIdx];
if (cur && cur.isBot) runCpuTurn(room);

/* ---------------- Bingo ---------------- */
function bingoRangeSet() { return new Set(Array.from({ length: 75 }, (_, i) => i + 1)); }
function randomBingoCard() {
  const cols = [
    [1,15],[16,30],[31,45],[46,60],[61,75]
  ];
  const grid = Array.from({length:5}, ()=>Array(5).fill(null));
  for (let c = 0; c < 5; c++) {
    const [a,b]=cols[c];
    const nums = shuffle(Array.from({length:b-a+1},(_,i)=>a+i)).slice(0,5);
    for (let r=0;r<5;r++) grid[r][c]=nums[r];
  }
  grid[2][2] = 'FREE';
  return grid;
}
function bingoCheckWin(card, markedSet) {
  const has = (v) => v === 'FREE' || markedSet.has(v);
  for (let r=0;r<5;r++) if ([0,1,2,3,4].every(c => has(card[r][c]))) return true;
  for (let c=0;c<5;c++) if ([0,1,2,3,4].every(r => has(card[r][c]))) return true;
  if ([0,1,2,3,4].every(i => has(card[i][i]))) return true;
  if ([0,1,2,3,4].every(i => has(card[i][4-i]))) return true;
  return false;
}
function bingoTick(room) {
  const g = room.bingo;
  if (!g || room.state !== 'playing' || room.gameType !== 'bingo') return;
  if (g.paused) return;
  const remaining = [...g.remaining];
  if (!remaining.length) return;
  const draw = remaining[Math.floor(Math.random()*remaining.length)];
  g.remaining.delete(draw);
  g.drawn.push(draw);
  broadcast(room, { type:'bingo_draw', number: draw, drawn: g.drawn });

  // auto-mark and check
  for (const p of room.players) {
    if (!p.bingoCard) continue;
    if (bingoCheckWin(p.bingoCard, new Set(g.drawn))) {
      room.state = 'over';
      g.winner = p.name;
      broadcast(room, { type:'gameover', winner: p.name });
      sendChat(room, 'Server', `${p.name} got BINGO!`);
      break;
    }
  }
}

/* ---------------- Blackjack ---------------- */
function bjBuildDeck() {
  const d = [];
  for (const s of SUITS) for (const r of RANKS) d.push({ suit:s, rank:r });
  // 6-deck shoe
  return shuffle([...d,...d,...d,...d,...d,...d]);
}
function bjVal(cards) {
  let total = 0, aces = 0;
  for (const c of cards) {
    if (c.rank === 'A') { total += 11; aces++; }
    else if (['K','Q','J'].includes(c.rank)) total += 10;
    else total += Number(c.rank);
  }
  while (total > 21 && aces) { total -= 10; aces--; }
  return total;
}
function bjState(room) {
  const g = room.bj;
  room.players.forEach((p, idx) => {
    if (!p.ws || p.ws.readyState !== 1) return;
    p.ws.send(JSON.stringify({
      type:'state',
      gameType:'blackjack',
      state: room.state,
      yourIdx: idx,
      players: room.players.map(op => ({
        name: op.name,
        connected: op.connected,
        chips: op.bj?.chips ?? 500,
        bet: op.bj?.bet ?? 0,
        stand: op.bj?.stand ?? false,
        bust: op.bj?.bust ?? false,
        hand: op === p ? (op.bj?.hand || []) : [{hidden:true}, ...((op.bj?.hand || []).slice(1))]
      })),
      dealer: {
        hand: g.revealDealer ? g.dealerHand : [g.dealerHand[0], {hidden:true}],
        value: g.revealDealer ? bjVal(g.dealerHand) : null
      },
      turnIdx: g.turnIdx,
      phase: g.phase,
      bettingEnabled: g.bettingEnabled
    }));
  });
}
function bjNextActive(room) {
  const g = room.bj;
  const n = room.players.length;
  for (let i=1;i<=n;i++) {
    const idx = (g.turnIdx + i) % n;
    const p = room.players[idx];
    if (!p.connected) continue;
    if (!p.bj) continue;
    if (p.bj.bust || p.bj.stand) continue;
    g.turnIdx = idx;
    return true;
  }
  return false;
}
function bjDealerPlay(room) {
  const g = room.bj;
  g.revealDealer = true;
  while (bjVal(g.dealerHand) < 17) g.dealerHand.push(g.deck.pop()); // stands on 17
  const dv = bjVal(g.dealerHand);
  room.players.forEach(p => {
    if (!p.bj) return;
    const pv = bjVal(p.bj.hand);
    if (p.bj.bust) p.bj.result = 'lose';
    else if (dv > 21) { p.bj.result = 'win'; p.bj.chips += p.bj.bet*2; }
    else if (pv > dv) { p.bj.result = 'win'; p.bj.chips += p.bj.bet*2; }
    else if (pv === dv) { p.bj.result = 'push'; p.bj.chips += p.bj.bet; }
    else p.bj.result = 'lose';
  });
  g.phase = 'settle';
  room.state = 'over';
  bjState(room);
}

/* ---------------- Start game router ---------------- */
function startGame(room) {
  if (room.players.filter(p=>p.connected).length < 1) return;
  room.state = 'playing';

  if (room.gameType === 'crazy_eights') {
    room.ce = { deck: ceBuildDeck(), discard: [], turnIdx: 0, hasDrawn: false, activeSuit:'', activeRank:'', winner:null };
    room.players.forEach(p => { p.hand = ceDraw(room, 7); });
    const first = room.ce.deck.pop();
    room.ce.discard.push(first);
    room.ce.activeSuit = first.suit;
    room.ce.activeRank = first.rank;
    ceSendState(room);
    sendChat(room, 'Server', 'Crazy Eights started.');
    return;
  }

  if (room.gameType === 'bingo') {
    room.bingo = {
      remaining: bingoRangeSet(),
      drawn: [],
      winner: null,
      autoDrawEnabled: room.bingo?.autoDrawEnabled ?? true,
      drawIntervalSec: room.bingo?.drawIntervalSec ?? 10,
      paused: false,
      timer: null
    };
    room.players.forEach(p => { p.bingoCard = randomBingoCard(); });
    broadcast(room, { type:'bingo_start', cards: room.players.map(p=>({name:p.name, card:p.bingoCard})) });
    if (room.bingo.autoDrawEnabled) {
      room.bingo.timer = setInterval(() => bingoTick(room), room.bingo.drawIntervalSec * 1000);
    }
    sendChat(room, 'Server', 'Bingo started.');
    return;
  }

  if (room.gameType === 'blackjack') {
    room.bj = {
      deck: bjBuildDeck(),
      dealerHand: [],
      revealDealer: false,
      phase: 'player_turn',
      turnIdx: 0,
      bettingEnabled: room.bj?.bettingEnabled ?? true
    };
    room.players.forEach(p => {
      p.bj = p.bj || { chips: 500 };
      const bet = room.bj.bettingEnabled ? Math.max(1, Math.min(50, p.bj.chips || 500)) : 0;
      p.bj.bet = bet;
      if (room.bj.bettingEnabled) p.bj.chips -= bet;
      p.bj.hand = [room.bj.deck.pop(), room.bj.deck.pop()];
      p.bj.stand = false; p.bj.bust = false; p.bj.result = null;
    });
    room.bj.dealerHand = [room.bj.deck.pop(), room.bj.deck.pop()];
    bjState(room);
    sendChat(room, 'Server', 'Blackjack started.');
  }
}
function nextConnectedIdx(room, startIdx) {
  const n = room.players.length;
  let idx = ((startIdx % n) + n) % n;
  let tries = 0;
  while (tries < n) {
    const p = room.players[idx];
    if (p && p.connected) return idx;
    idx = (idx + 1) % n;
    tries++;
  }
  return 0;
}

function runCpuTurn(room) {
  if (room.state !== 'playing') return;
  const p = room.players[room.ce.turnIdx];
  if (!p || !p.isBot) return;

  const delay = 700 + Math.floor(Math.random() * 900);

  setTimeout(() => {
    if (room.state !== 'playing') return;
    const bot = room.players[room.ce.turnIdx];
    if (!bot || !bot.isBot) return;

    // Crazy Eights CPU logic
    const playableIdx = (bot.hand || []).findIndex(c => ceCanPlay(c, room.ce.activeSuit, room.ce.activeRank));

    if (playableIdx !== -1) {
      const card = bot.hand[playableIdx];
      let chosenSuit = card.suit;

      if (card.rank === '8') {
        const counts = { Spades: 0, Hearts: 0, Diamonds: 0, Clubs: 0 };
        bot.hand.forEach(c => { if (counts[c.suit] !== undefined) counts[c.suit]++; });
        chosenSuit = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b, 'Spades');
      }

      handlePlay(room, room.ce.turnIdx, playableIdx, chosenSuit);
    } else {
      handleDraw(room, room.ce.turnIdx);

      const last = bot.hand[bot.hand.length - 1];
      if (last && ceCanPlay(last, room.ce.activeSuit, room.ce.activeRank)) {
        const chosenSuit = last.rank === '8' ? last.suit : last.suit;
        handlePlay(room, room.ce.turnIdx, bot.hand.length - 1, chosenSuit);
      } else {
        handlePass(room, room.ce.turnIdx);
      }
    }
  }, delay);
}
function endBingoTimer(room) {
  if (room?.bingo?.timer) { clearInterval(room.bingo.timer); room.bingo.timer = null; }
}

wss.on('connection', (ws) => {
  let myRoom = null;
  let myIdx = -1;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }
if (msg.type === 'set_cpus') {
  if (!myRoom || myIdx !== 0) return; // host only

  const count = Math.max(0, Math.min(9, Number(msg.count || 0)));

  // keep humans, remove old CPUs
  const humans = myRoom.players.filter(p => !p.isBot);
  const bots = [];

  for (let i = 0; i < count; i++) {
    bots.push({
      id: humans.length + i,
      name: `CPU ${i + 1} 🤖`,
      ws: null,
      connected: true,
      isBot: true,
      hand: []
    });
  }

  myRoom.players = [...humans, ...bots];

  // keep valid turn index if game already running
  if (myRoom.state === 'playing' && myRoom.ce) {
    myRoom.ce.turnIdx = nextConnectedIdx(myRoom, myRoom.ce.turnIdx);
  }

  broadcast(myRoom, lobbyPayload(myRoom));
  if (myRoom.state === 'playing' && myRoom.gameType === 'crazy_eights') {
    ceSendState(myRoom);
  }
  return;
}
    if (msg.type === 'join') {
      const code = (msg.code || '').toUpperCase().trim();
      const name = (msg.name || 'Player').slice(0, 20).trim();
      if (!code || code.length < 2) return ws.send(JSON.stringify({ type:'error', msg:'Invalid room code.' }));

      if (!rooms[code]) rooms[code] = makeRoom(code);
      const room = rooms[code];
      if (room.players.length === 0 && msg.gameType) room.gameType = msg.gameType;

      let existing = room.players.find(p => p.name.toLowerCase() === name.toLowerCase());
      if (existing) {
        if (existing.connected) return ws.send(JSON.stringify({ type:'error', msg:'Name taken!' }));
        existing.ws = ws; existing.connected = true; myIdx = room.players.indexOf(existing);
      } else {
        if (room.state !== 'lobby') return ws.send(JSON.stringify({ type:'error', msg:'Game in progress.' }));
        if (room.players.length >= MAX_PLAYERS) return ws.send(JSON.stringify({ type:'error', msg:'Room full!' }));
        myIdx = room.players.length;
        room.players.push({ id: myIdx, name, ws, connected: true, isBot: false, hand: [] });
      }
      myRoom = room;
      ws.send(JSON.stringify({ type:'joined', code, name, yourIdx: myIdx, isHost: myIdx===0, playerCount: room.players.length, gameType: room.gameType }));
      sendChat(room, 'Server', `${name} joined.`);
      broadcast(room, lobbyPayload(room));
      return;
    }

    if (!myRoom) return;

    if (msg.type === 'set_room_options') {
      if (myIdx !== 0) return;
      myRoom.chatFilterEnabled = !!msg.chatFilterEnabled;
      myRoom.hostCanClearChat = !!msg.hostCanClearChat;
      myRoom.gameplayMusicEnabled = !!msg.gameplayMusicEnabled;

      myRoom.bj = myRoom.bj || {};
      myRoom.bj.bettingEnabled = msg.bjBettingEnabled !== false;

      myRoom.bingo = myRoom.bingo || {};
      myRoom.bingo.autoDrawEnabled = msg.bingoAutoDrawEnabled !== false;
      myRoom.bingo.drawIntervalSec = Number(msg.bingoDrawIntervalSec || 10);
      if (typeof msg.bingoPaused === 'boolean') myRoom.bingo.paused = msg.bingoPaused;

      broadcast(myRoom, lobbyPayload(myRoom));
      return;
    }

    if (msg.type === 'start') {
      if (myIdx !== 0) return;
      startGame(myRoom);
      return;
    }

    // common
    if (msg.type === 'chat') {
      if (myIdx < 0) return;
      sendChat(myRoom, myRoom.players[myIdx].name, (msg.text || '').slice(0, 200));
      return;
    }
    if (msg.type === 'clear_chat') {
      if (myIdx !== 0 || !myRoom.hostCanClearChat) return;
      broadcast(myRoom, { type:'chat_cleared' });
      sendChat(myRoom, 'Server', `${myRoom.players[myIdx].name} cleared chat.`);
      return;
    }
    if (msg.type === 'restart') {
      if (myIdx !== 0) return;
      endBingoTimer(myRoom);
      myRoom.state = 'lobby';
      myRoom.ce = myRoom.bingo = myRoom.bj = null;
      myRoom.players.forEach(p => { p.hand = []; p.bingoCard = null; });
      broadcast(myRoom, lobbyPayload(myRoom));
      return;
    }

    // Crazy Eights
    if (myRoom.gameType === 'crazy_eights') {
      if (msg.type === 'play') {
        handlePlay(myRoom, myIdx, msg.cardIdx, msg.chosenSuit || msg.chosenColor);
        return;
      }
      if (msg.type === 'draw') { handleDraw(myRoom, myIdx); return; }
      if (msg.type === 'pass') { handlePass(myRoom, myIdx); return; }
    }

    // Bingo
    if (myRoom.gameType === 'bingo') {
      if (msg.type === 'bingo_draw_next' && myIdx === 0) { bingoTick(myRoom); return; }
      if (msg.type === 'bingo_pause' && myIdx === 0) { myRoom.bingo.paused = true; broadcast(myRoom, lobbyPayload(myRoom)); return; }
      if (msg.type === 'bingo_resume' && myIdx === 0) { myRoom.bingo.paused = false; broadcast(myRoom, lobbyPayload(myRoom)); return; }
      if (msg.type === 'bingo_claim') {
        const p = myRoom.players[myIdx];
        if (!p?.bingoCard) return;
        if (bingoCheckWin(p.bingoCard, new Set(myRoom.bingo.drawn))) {
          myRoom.state = 'over';
          endBingoTimer(myRoom);
          broadcast(myRoom, { type:'gameover', winner:p.name });
          sendChat(myRoom, 'Server', `${p.name} called BINGO and won!`);
        } else {
          ws.send(JSON.stringify({ type:'error', msg:'Not a valid bingo yet.' }));
        }
        return;
      }
    }

    // Blackjack
    if (myRoom.gameType === 'blackjack') {
      if (msg.type === 'bj_hit') {
        const g = myRoom.bj; if (!g || myIdx !== g.turnIdx) return;
        const p = myRoom.players[myIdx]; if (!p?.bj || p.bj.stand || p.bj.bust) return;
        p.bj.hand.push(g.deck.pop());
        if (bjVal(p.bj.hand) > 21) p.bj.bust = true;
        if (p.bj.bust || p.bj.stand) {
          if (!bjNextActive(myRoom)) bjDealerPlay(myRoom);
        }
        bjState(myRoom);
        return;
      }
      if (msg.type === 'bj_stand') {
        const g = myRoom.bj; if (!g || myIdx !== g.turnIdx) return;
        const p = myRoom.players[myIdx]; if (!p?.bj) return;
        p.bj.stand = true;
        if (!bjNextActive(myRoom)) bjDealerPlay(myRoom);
        else bjState(myRoom);
        return;
      }
    }
  });

  ws.on('close', () => {
    
    if (!myRoom || myIdx < 0) return;
    const room = myRoom;
    if (!room.players[myIdx]) return;
    if (!room.players[myIdx].isBot) room.players[myIdx].connected = false;
    sendChat(room, 'Server', `${room.players[myIdx].name} disconnected.`);

    // bingo fallback: if host disconnects, force auto-draw on
    if (room.gameType === 'bingo' && myIdx === 0 && room.state === 'playing') {
      room.bingo.autoDrawEnabled = true;
      room.bingo.paused = false;
      if (!room.bingo.timer) room.bingo.timer = setInterval(() => bingoTick(room), (room.bingo.drawIntervalSec || 10) * 1000);
    }

    const anyoneLeft = room.players.some(p => p.connected && !p.isBot);
    if (!anyoneLeft) {
      endBingoTimer(room);
      delete rooms[room.code];
      return;
    }
    broadcast(room, lobbyPayload(room));
  });
});

httpServer.listen(PORT, () => console.log(`Tabletop Online server on ${PORT}`));

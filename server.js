// ============================================================
// UNO Multiplayer Server — Node.js + ws
// Updated for: Rejoining, Duplicate Prevention, and Auto-Resets
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const PORT = process.env.PORT || 3000;

// ── HTTP server: serve uno.html + assets ─────────────────────
const httpServer = http.createServer((req, res) => {
    let filePath = path.join(__dirname, req.url === '/' ? 'uno.html' : req.url);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath);
        const types = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.png':'image/png' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
        res.end(data);
    });
});

const wss = new WebSocketServer({ server: httpServer });

// ── Game constants ───────────────────────────────────────────
const COLORS = ['Red','Green','Blue','Yellow'];
const VALUES = ['0','1','2','3','4','5','6','7','8','9','S','R','+2'];
const COLOR_HEX = { Red:'#ff595e', Green:'#8ac926', Blue:'#1982c4', Yellow:'#ffca3a', Wild:'#333' };
const MAX_PLAYERS = 10;
const HAND_SIZE = 7;

// ── State ────────────────────────────────────────────────────
let rooms = {}; 

function makeRoom(code) {
    return {
        code,
        players: [], // { id, name, ws, hand:[], connected:true }
        state: 'lobby', 
        deck: [],
        discard: [],
        turnIdx: 0,
        dir: 1,
        activeColor: '',
        activeVal: '',
        hasDrawn: false,
        winner: null,
    };
}

function buildDeck() {
    const deck = [];
    for (const col of COLORS) {
        for (const val of VALUES) {
            deck.push({ col, val });
            if (val !== '0') deck.push({ col, val });
        }
    }
    for (let i = 0; i < 4; i++) {
        deck.push({ col:'Wild', val:'W' });
        deck.push({ col:'Wild', val:'+4' });
    }
    return shuffle(deck);
}

function shuffle(a) {
    for (let i = a.length-1; i>0; i--) {
        const j = Math.floor(Math.random()*(i+1));
        [a[i],a[j]] = [a[j],a[i]];
    }
    return a;
}

function draw(room, n=1) {
    const cards = [];
    for (let i=0; i<n; i++) {
        if (room.deck.length === 0) {
            if (room.discard.length <= 1) break;
            const top = room.discard.pop();
            room.deck = shuffle(room.discard);
            room.discard = [top];
        }
        if (room.deck.length) cards.push(room.deck.pop());
    }
    return cards;
}

function canPlay(card, activeColor, activeVal) {
    return card.col === 'Wild' || card.col === activeColor || card.val === activeVal;
}

function broadcast(room, msg) {
    room.players.forEach(p => {
        if (p.ws && p.ws.readyState === WebSocket.OPEN) {
            p.ws.send(JSON.stringify(msg));
        }
    });
}

function sendState(room) {
    const top = room.discard[room.discard.length-1];
    room.players.forEach((p, idx) => {
        if (!p.ws || p.ws.readyState !== WebSocket.OPEN) return;
        const others = room.players.map((op, oi) => ({
            name: op.name,
            cardCount: op.hand.length,
            isCurrentTurn: oi === room.turnIdx,
            isYou: oi === idx,
            connected: op.connected,
        }));
        p.ws.send(JSON.stringify({
            type: 'state',
            hand: p.hand,
            others,
            topCard: top || null,
            activeColor: room.activeColor,
            activeVal: room.activeVal,
            turnIdx: room.turnIdx,
            yourIdx: idx,
            deckCount: room.deck.length,
            dir: room.dir,
            hasDrawn: room.hasDrawn,
            state: room.state,
            winner: room.winner,
        }));
    });
}

function sendChat(room, from, text) {
    broadcast(room, { type:'chat', from, text });
}

function nextTurn(room, steps=1) {
    const n = room.players.length;
    // Basic skip logic: if next player is disconnected, skip them too
    let nextIdx = ((room.turnIdx + room.dir * steps) % n + n) % n;
    
    // Safety: prevent infinite loop if everyone is disconnected
    let attempts = 0;
    while (!room.players[nextIdx].connected && attempts < n) {
        nextIdx = ((nextIdx + room.dir) % n + n) % n;
        attempts++;
    }

    room.turnIdx = nextIdx;
    room.hasDrawn = false;
}

function handlePlay(room, playerIdx, cardIdx, chosenColor) {
    if (room.state !== 'playing') return;
    if (playerIdx !== room.turnIdx) return;
    const player = room.players[playerIdx];
    const card = player.hand[cardIdx];
    if (!card) return;
    if (!canPlay(card, room.activeColor, room.activeVal)) {
        player.ws.send(JSON.stringify({ type:'error', msg:"Can't play that card!" }));
        return;
    }
    player.hand.splice(cardIdx, 1);
    room.discard.push(card);
    let newColor = card.col === 'Wild' ? chosenColor : card.col;
    let newVal = card.val;
    room.activeColor = newColor;
    room.activeVal = newVal;
    
    sendChat(room, player.name, `played ${card.val === 'W' ? 'Wild' : card.val === '+4' ? 'Wild +4' : card.col + ' ' + card.val}${card.col==='Wild' ? ' → chose '+newColor : ''}`);
    
    if (player.hand.length === 0) {
        room.state = 'over';
        room.winner = player.name;
        broadcast(room, { type:'gameover', winner: player.name });
        sendState(room);
        return;
    }
    
    if (player.hand.length === 1) sendChat(room, player.name, 'UNO! 🟡');

    const n = room.players.length;
    if (newVal === 'S') {
        nextTurn(room, 2); 
    } else if (newVal === 'R') {
        room.dir *= -1;
        nextTurn(room, n > 2 ? 1 : 2);
    } else if (newVal === '+2') {
        const nextP = ((room.turnIdx + room.dir) % n + n) % n;
        room.players[nextP].hand.push(...draw(room, 2));
        sendChat(room, 'Server', `${room.players[nextP].name} draws 2!`);
        nextTurn(room, 2);
    } else if (newVal === '+4') {
        const nextP = ((room.turnIdx + room.dir) % n + n) % n;
        room.players[nextP].hand.push(...draw(room, 4));
        sendChat(room, 'Server', `${room.players[nextP].name} draws 4!`);
        nextTurn(room, 2);
    } else {
        nextTurn(room);
    }
    sendState(room);
}

function handleDraw(room, playerIdx) {
    if (room.state !== 'playing') return;
    if (playerIdx !== room.turnIdx) return;
    if (room.hasDrawn) return;
    const player = room.players[playerIdx];
    const cards = draw(room, 1);
    player.hand.push(...cards);
    room.hasDrawn = true;
    sendChat(room, player.name, 'drew a card');
    sendState(room);
}

function handlePass(room, playerIdx) {
    if (room.state !== 'playing') return;
    if (playerIdx !== room.turnIdx) return;
    if (!room.hasDrawn) return;
    nextTurn(room);
    sendState(room);
}

function startGame(room) {
    if (room.players.length < 2) return;
    room.state = 'playing';
    room.deck = buildDeck();
    room.discard = [];
    room.turnIdx = 0;
    room.dir = 1;
    room.hasDrawn = false;
    room.winner = null;
    room.players.forEach(p => { p.hand = draw(room, HAND_SIZE); p.connected = true; });
    
    let startCard;
    do { startCard = room.deck.pop(); } while (['W','+4','S','+2','R'].includes(startCard.val));
    room.discard.push(startCard);
    room.activeColor = startCard.col;
    room.activeVal = startCard.val;
    
    sendChat(room, 'Server', 'Game started! ' + room.players.map(p=>p.name).join(', '));
    sendState(room);
}

// ── WebSocket connection handler ─────────────────────────────
wss.on('connection', (ws) => {
    let myRoom = null;
    let myIdx = -1;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.type === 'join') {
            const code = (msg.code || '').toUpperCase().trim();
            const name = (msg.name || 'Player').slice(0, 20).trim();
            if (!code || code.length < 2) {
                ws.send(JSON.stringify({ type:'error', msg:'Invalid room code.' })); 
                return;
            }

            if (!rooms[code]) rooms[code] = makeRoom(code);
            const room = rooms[code];

            // Fix: Check for duplicate names
            const existingPlayer = room.players.find(p => p.name.toLowerCase() === name.toLowerCase());
            
            if (existingPlayer) {
                if (existingPlayer.connected) {
                    ws.send(JSON.stringify({ type:'error', msg:'Name already taken in this room!' }));
                    return;
                } else {
                    // Rejoin logic
                    existingPlayer.ws = ws;
                    existingPlayer.connected = true;
                    myIdx = room.players.indexOf(existingPlayer);
                }
            } else {
                if (room.state !== 'lobby') {
                    ws.send(JSON.stringify({ type:'error', msg:'Game in progress. Cannot join new players.' })); 
                    return;
                }
                if (room.players.length >= MAX_PLAYERS) {
                    ws.send(JSON.stringify({ type:'error', msg:'Room is full!' })); 
                    return;
                }
                myIdx = room.players.length;
                room.players.push({ id: myIdx, name, ws, hand:[], connected:true });
            }

            myRoom = room;
            const isHost = myIdx === 0;
            ws.send(JSON.stringify({ type:'joined', code, name, yourIdx:myIdx, isHost, playerCount: room.players.length }));
            sendChat(room, 'Server', `${name} joined.`);
            broadcast(room, { type:'lobby', players: room.players.map(p=>p.name), hostName: room.players[0].name });
            if (room.state === 'playing') sendState(room);
            return;
        }

        if (!myRoom) return;
        const room = myRoom;

        if (msg.type === 'start') {
            if (myIdx !== 0) return;
            startGame(room);
            return;
        }
        if (msg.type === 'play') { handlePlay(room, myIdx, msg.cardIdx, msg.chosenColor); return; }
        if (msg.type === 'draw') { handleDraw(room, myIdx); return; }
        if (msg.type === 'pass') { handlePass(room, myIdx); return; }
        if (msg.type === 'chat') { sendChat(room, room.players[myIdx].name, (msg.text||'').slice(0,200)); return; }
        
        if (msg.type === 'restart') {
            if (myIdx !== 0) return;
            room.state = 'lobby';
            room.players.forEach(p => { p.hand = []; });
            broadcast(room, { type:'lobby', players: room.players.map(p=>p.name), hostName: room.players[0].name });
            return;
        }
    });

    ws.on('close', () => {
        if (!myRoom || myIdx < 0) return;
        const room = myRoom;
        if (room.players[myIdx]) {
            room.players[myIdx].connected = false;
            sendChat(room, 'Server', `${room.players[myIdx].name} disconnected.`);
            
            // Fix: Auto-skip if it was their turn
            if (room.state === 'playing' && room.turnIdx === myIdx) {
                sendChat(room, 'Server', `Skipping ${room.players[myIdx].name}'s turn...`);
                nextTurn(room);
            }

            // Fix: Reset room if everyone left
            const anyoneLeft = room.players.some(p => p.connected);
            if (!anyoneLeft) {
                console.log(`Room ${room.code} cleared (empty).`);
                delete rooms[room.code];
                return;
            }

            broadcast(room, { type:'lobby', players: room.players.map(p=>p.name), hostName: room.players[0].name });
            if (room.state === 'playing') sendState(room);
        }
    });
});

httpServer.listen(PORT, () => console.log(`UNO Server running on port ${PORT}`));

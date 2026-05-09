// ============================================================
// Tabletop Online Server — Node.js + ws
// Fixed for: WebSocket Reference Errors, CPU Logic, and Start Crashes
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const PROFANITY_LIST = require('./profanity-list');
const PORT = process.env.PORT || 3000;

// ── HTTP server: serve uno.html + assets ─────────────────────
const httpServer = http.createServer((req, res) => {
    let filePath = path.join(__dirname, req.url === '/' ? 'uno.html' : req.url);
    fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not found'); return; }
        const ext = path.extname(filePath);
        const types = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.png':'image/png', '.svg':'image/svg+xml', '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.wav':'audio/wav' };
        res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
        res.end(data);
    });
});

const wss = new WebSocketServer({ server: httpServer });

// ── Game constants ───────────────────────────────────────────
const SUITS = ['Spades','Hearts','Diamonds','Clubs'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const MAX_PLAYERS = 10;
const HAND_SIZE = 7;
const CHIP_DENOMINATIONS = [1, 5, 10, 20, 50, 100, 500];
const VALID_GAME_TYPES = ['chat_room', 'crazy_eights', 'bingo', 'blackjack_chips', 'texas_holdem', 'left_center_right'];
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const BOT_PERSONAS = [
    { name: 'Grog the Barbarian 🤖', personality: 'loud, brave, goofy, and obsessed with big dramatic moves' },
    { name: 'Melf the Mage 🤖', personality: 'clever, mystical, and fond of over-explaining strategy with sparkle' },
    { name: 'Pip the Rogue 🤖', personality: 'sneaky, playful, and always pretending every move was planned' },
    { name: 'Nora the Navigator 🤖', personality: 'calm, upbeat, nautical, and encouraging to everyone at the table' },
    { name: 'Bingo Bess 🤖', personality: 'cheerful, lucky, and extremely excited whenever numbers appear' },
    { name: 'Chip McStack 🤖', personality: 'competitive, chip-counting, and full of casino-table banter' },
    { name: 'Professor Pips 🤖', personality: 'dry, academic, and convinced every dice roll is research' },
    { name: 'Zara the Bard 🤖', personality: 'dramatic, rhyming, and always narrating the table like a tavern song' },
    { name: 'Byte Knight 🤖', personality: 'honorable, robotic, and proud of clean logical plays' },
];
const AI_CHAT_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const AI_CHAT_HISTORY_LIMIT = 16;
const AI_CHAT_COOLDOWN_MS = 3500;

// ── State ────────────────────────────────────────────────────
let rooms = {}; 

function makeRoom(code) {
    return {
        code,
        players: [], // { id, name, ws, hand:[], connected:true, isBot: false }
        state: 'lobby', 
        deck: [],
        discard: [],
        turnIdx: 0,
        dir: 1,
        activeSuit: '',
        activeRank: '',
        hasDrawn: false,
        winner: null,
        gameType: 'crazy_eights',
        chatFilterEnabled: false,
        gameplayMusicEnabled: true,
        bingoMode: 'hard',
        soundSeq: 0,
        aiChatHistory: [],
        aiChatPending: false,
        lastAIChatAt: 0,
        tableData: null,
    };
}

function buildDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const rank of RANKS) {
            deck.push({ suit, rank });
        }
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

function canPlay(card, activeSuit, activeRank) {
    return card.rank === '8' || card.suit === activeSuit || card.rank === activeRank;
}

function broadcast(room, msg) {
    room.players.forEach(p => {
        // FIXED: WebSocket.OPEN replaced with 1
        if (p.ws && p.ws.readyState === 1) {
            p.ws.send(JSON.stringify(msg));
        }
    });
}

function sendState(room) {
    const top = room.discard[room.discard.length-1];
    room.players.forEach((p, idx) => {
        // FIXED: WebSocket.OPEN replaced with 1
        if (!p.ws || p.ws.readyState !== 1) return;
        
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
            activeSuit: room.activeSuit,
            activeRank: room.activeRank,
            turnIdx: room.turnIdx,
            yourIdx: idx,
            deckCount: room.deck.length,
            dir: room.dir,
            hasDrawn: room.hasDrawn,
            state: room.state,
            winner: room.winner,
            gameplayMusicEnabled: room.gameplayMusicEnabled,
            gameType: room.gameType,
        }));
    });
}

function filterChatText(text) {
    let safe = String(text || '');
    for (const word of PROFANITY_LIST) {
        const re = new RegExp(`\\b${word}\\b`, 'gi');
        safe = safe.replace(re, (m) => '*'.repeat(m.length));
    }
    return safe;
}


function prettyGameName(gameType) {
    return ({
        crazy_eights: 'Crazy Eights',
        bingo: 'Bingo',
        blackjack_chips: 'Blackjack + Chips',
        texas_holdem: "Texas Hold'em",
        left_center_right: 'Left Center Right',
        chat_room: 'Chat Room',
    })[gameType] || String(gameType || 'Unknown game').replaceAll('_', ' ');
}

function sendChat(room, from, text) {
    const safeText = room.chatFilterEnabled && from !== 'Server' ? filterChatText(text) : text;
    broadcast(room, { type:'chat', from, text: safeText });
}

function lobbyPayload(room) {
    return {
        type: 'lobby',
        players: room.players.filter(p => p.connected || p.isBot).map(p => p.name),
        hostName: room.players.find(p => p.connected && !p.isBot)?.name || room.players[0]?.name || 'Host',
        chatFilterEnabled: room.chatFilterEnabled,
        gameType: room.gameType,
        gameplayMusicEnabled: room.gameplayMusicEnabled,
        bingoMode: room.bingoMode || 'hard',
    };
}

function markTableSound(room, sound) {
    if (!room || !room.tableData) return;
    room.soundSeq = (room.soundSeq || 0) + 1;
    room.tableData.soundEvent = { seq: room.soundSeq, sound };
}

function getBotPersona(index) {
    return BOT_PERSONAS[index % BOT_PERSONAS.length];
}

function rememberRoomChat(room, speaker, text, role = 'user') {
    if (!room) return;
    room.aiChatHistory.push({ role, speaker, text: String(text || '').slice(0, 220) });
    room.aiChatHistory = room.aiChatHistory.slice(-AI_CHAT_HISTORY_LIMIT);
}

function localBotLine(bot, action = 'move') {
    const lines = {
        move: ['A calculated flourish!', 'My gears say that was brilliant.', 'Your move, table friends!'],
        play: ['Aha! A card with style!', 'I cast this card upon the table!', 'That should stir the pot.'],
        draw: ['A tactical draw. Definitely tactical.', 'More cards, more destiny.', 'I meant to do that.'],
        pass: ['I pass... with dignity.', 'A pause for dramatic effect.', 'I shall wait for a better moment.'],
        bet: ['I place my chips with confidence!', 'The chips have spoken.', 'Fortune favors bold circuits!'],
        roll: ['Rattle and roll!', 'Let the dice decide my legend!', 'Tiny cubes, mighty fate!'],
        bingo: ['Eyes sharp, cards ready!', 'Numbers are dancing now!', 'Mark fast, friends!'],
    };
    const options = lines[action] || lines.move;
    const prefix = bot?.personality?.includes('rhyming') ? 'Hear my table tale: ' : '';
    return prefix + options[Math.floor(Math.random() * options.length)];
}

function botChat(room, bot, text, remember = true) {
    if (!room || !bot || !text) return;
    const line = String(text).replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!line) return;
    sendChat(room, bot.name, line);
    if (remember) rememberRoomChat(room, bot.name, line, 'assistant');
}

function botMoveChat(room, botOrIdx, action) {
    const bot = typeof botOrIdx === 'number' ? room.players[botOrIdx] : botOrIdx;
    if (!bot?.isBot) return;
    setTimeout(() => botChat(room, bot, localBotLine(bot, action), true), 250);
}

function getOpenAIClient() {
    if (!process.env.OPENAI_API_KEY) return null;
    const OpenAI = require('openai');
    return new OpenAI();
}

async function maybeRunAIChat(room, humanName, humanText) {
    if (!room || room.aiChatPending || !room.players.some(p => p.isBot)) return;
    if (!process.env.OPENAI_API_KEY) return;
    const now = Date.now();
    if (now - (room.lastAIChatAt || 0) < AI_CHAT_COOLDOWN_MS) return;
    room.aiChatPending = true;
    room.lastAIChatAt = now;
    const bots = room.players.filter(p => p.isBot).map(p => ({ name: p.name, personality: p.personality || 'friendly table-game CPU' }));
    const transcript = room.aiChatHistory.slice(-AI_CHAT_HISTORY_LIMIT).map(m => `${m.speaker}: ${m.text}`).join('\n');
    const instructions = `You orchestrate playful CPU chat in a family-friendly Tabletop Online room. Pick exactly one CPU from this list to respond: ${bots.map(b => `${b.name} (${b.personality})`).join('; ')}. Keep the response under 22 words, react to the latest human message, do not mention being an AI model, and return JSON only like {"speaker":"CPU name","message":"short chat"}.`;
    try {
        const client = getOpenAIClient();
        if (!client) return;
        const response = await client.responses.create({
            model: AI_CHAT_MODEL,
            instructions,
            input: `Game: ${prettyGameName(room.gameType)}\nRecent chat:\n${transcript}\nLatest human message from ${humanName}: ${humanText}`,
            max_output_tokens: 90,
        });
        const raw = (response.output_text || '').trim();
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        const chosen = bots.find(b => b.name === parsed?.speaker) || bots[Math.floor(Math.random() * bots.length)];
        const bot = room.players.find(p => p.name === chosen.name && p.isBot);
        const message = parsed?.message || localBotLine(bot, 'move');
        botChat(room, bot, message, true);
    } catch (err) {
        console.warn('AI CPU chat skipped:', err.message);
    } finally {
        room.aiChatPending = false;
    }
}

function nextTurn(room, steps=1) {
    const n = room.players.length;
    let nextIdx = ((room.turnIdx + room.dir * steps) % n + n) % n;
    
    let attempts = 0;
    while (!room.players[nextIdx].connected && attempts < n) {
        nextIdx = ((nextIdx + room.dir) % n + n) % n;
        attempts++;
    }
    room.turnIdx = nextIdx;
    room.hasDrawn = false;
    
    if (room.players[room.turnIdx].isBot) {
        runBotTurn(room);
    }
}

function handlePlay(room, playerIdx, cardIdx, chosenSuit) {
    if (room.state !== 'playing') return;
    if (playerIdx !== room.turnIdx) return;
    const player = room.players[playerIdx];
    const card = player.hand[cardIdx];
    if (!card) return;

    if (!canPlay(card, room.activeSuit, room.activeRank)) {
        if (player.ws) player.ws.send(JSON.stringify({ type:'error', msg:"Can't play that card!" }));
        return;
    }

    player.hand.splice(cardIdx, 1);
    room.discard.push(card);
    const newSuit = card.rank === '8' ? (SUITS.includes(chosenSuit) ? chosenSuit : card.suit) : card.suit;
    room.activeSuit = newSuit;
    room.activeRank = card.rank;

    sendChat(room, 'Server', `${player.name} played ${card.rank} of ${card.suit}${card.rank === '8' ? ' → chose ' + newSuit : ''}`);

    if (player.hand.length === 0) {
        room.state = 'over';
        room.winner = player.name;
        broadcast(room, { type:'gameover', winner: player.name, gameType: room.gameType });
        sendState(room);
        return;
    }

    if (player.hand.length === 1) sendChat(room, 'Server', `${player.name} has one card left!`);

    nextTurn(room);
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
    sendChat(room, "Server", `${player.name} drew a card`);
    sendState(room);
}

function handlePass(room, playerIdx) {
    if (room.state !== 'playing') return;
    if (playerIdx !== room.turnIdx) return;
    if (!room.hasDrawn) return;
    sendChat(room, "Server", `${room.players[playerIdx].name} passed`);
    nextTurn(room);
    sendState(room);
}


function makeChipPlayers(room, startingChips) {
    return room.players.map((p, idx) => ({
        name: p.name,
        connected: p.connected,
        isBot: !!p.isBot,
        isYou: false,
        seat: idx,
        chips: startingChips,
        bet: 0,
        cards: [],
        stand: false,
        bust: false,
        result: null,
    }));
}

function cardValue(cards) {
    let total = 0;
    let aces = 0;
    for (const c of cards || []) {
        if (!c || c.hidden) continue;
        if (c.rank === 'A') { total += 11; aces++; }
        else if (['K', 'Q', 'J'].includes(c.rank)) total += 10;
        else total += Number(c.rank);
    }
    while (total > 21 && aces) { total -= 10; aces--; }
    return total;
}

function randomBingoCard() {
    const ranges = [[1,15], [16,30], [31,45], [46,60], [61,75]];
    const card = Array.from({ length: 5 }, () => Array(5).fill(null));
    for (let c = 0; c < 5; c++) {
        const [min, max] = ranges[c];
        const nums = shuffle(Array.from({ length: max - min + 1 }, (_, i) => min + i)).slice(0, 5);
        for (let r = 0; r < 5; r++) card[r][c] = nums[r];
    }
    card[2][2] = 'FREE';
    return card;
}

function bingoHasWin(card, marked) {
    const has = (r, c) => card[r][c] === 'FREE' || marked.includes(card[r][c]);
    for (let r = 0; r < 5; r++) if ([0,1,2,3,4].every(c => has(r, c))) return true;
    for (let c = 0; c < 5; c++) if ([0,1,2,3,4].every(r => has(r, c))) return true;
    if ([0,1,2,3,4].every(i => has(i, i))) return true;
    if ([0,1,2,3,4].every(i => has(i, 4 - i))) return true;
    return false;
}

function currentPlayerIdx(data, room) {
    const players = data.players || [];
    const n = players.length;
    for (let i = 0; i < n; i++) {
        const idx = ((data.turnIdx || 0) + i) % n;
        if (room.players[idx]?.connected && (players[idx]?.chips > 0 || players[idx]?.bet > 0 || players[idx]?.cards?.length)) return idx;
    }
    return 0;
}

function sendTableState(room) {
    const data = room.tableData || {};
    room.players.forEach((p, idx) => {
        if (!p.ws || p.ws.readyState !== 1) return;
        const players = (data.players || []).map((op, oi) => {
            const copy = { ...op, isYou: oi === idx };
            if (room.gameType === 'texas_holdem' && oi !== idx && data.phase !== 'showdown') {
                copy.cards = (op.cards || []).map(() => ({ hidden: true }));
            }
            return copy;
        });
        p.ws.send(JSON.stringify({
            type: 'state',
            gameType: room.gameType,
            state: room.state,
            yourIdx: idx,
            players,
            dealer: data.dealer || null,
            community: data.community || [],
            pot: data.pot || 0,
            currentBet: data.currentBet || 0,
            minRaise: data.minRaise || BIG_BLIND,
            dealerIdx: data.dealerIdx ?? null,
            smallBlindIdx: data.smallBlindIdx ?? null,
            bigBlindIdx: data.bigBlindIdx ?? null,
            revealedStage: data.revealedStage || '',
            centerChips: data.centerChips || 0,
            calledNumber: data.calledNumber || null,
            calledNumbers: data.calledNumbers || [],
            bingoCard: data.bingoCards?.[idx] || null,
            marked: data.marked?.[idx] || [],
            bingoCards: room.gameType === 'bingo' ? data.bingoCards || [] : undefined,
            allMarked: room.gameType === 'bingo' ? data.marked || [] : undefined,
            bingoMode: room.bingoMode || 'hard',
            phase: data.phase || '',
            turnIdx: data.turnIdx ?? 0,
            dice: data.dice || [],
            diceRolling: !!data.diceRolling,
            bingoDrawing: !!data.bingoDrawing,
            message: data.message || '',
            soundEvent: data.soundEvent || null,
            chipDenominations: CHIP_DENOMINATIONS,
            gameplayMusicEnabled: room.gameplayMusicEnabled,
        }));
    });
}


function activeSeatIndexes(room) {
    return room.players.map((p, idx) => idx).filter(idx => room.players[idx].connected && room.tableData?.players?.[idx]);
}

function autoBlackjackBots(room) {
    const data = room.tableData;
    data.players.forEach((p, idx) => {
        if (!room.players[idx].isBot || !room.players[idx].connected || p.chips <= 0) return;
        if (data.phase === 'betting' && p.bet <= 0) {
            const amount = Math.min(25, p.chips);
            p.bet = amount;
            p.chips -= amount;
            p.doneBetting = true;
            data.pot += amount;
        }
    });
}

function dealBlackjackIfReady(room) {
    const data = room.tableData;
    autoBlackjackBots(room);
    const waiting = data.players.some((p, idx) => room.players[idx].connected && (!p.doneBetting || p.bet <= 0));
    if (waiting) return false;
    data.players.forEach((p, idx) => {
        if (!room.players[idx].connected || p.bet <= 0) return;
        p.cards = [room.deck.pop(), room.deck.pop()];
        p.stand = false;
        p.bust = false;
        p.result = null;
        p.insurance = 0;
        p.insuranceOffered = false;
    });
    data.dealer = { cards: [room.deck.pop(), { hidden: true }], reveal: false };
    data.phase = data.dealer.cards[0]?.rank === 'A' ? 'insurance' : 'player_turn';
    data.turnIdx = currentPlayerIdx(data, room);
    if (data.phase === 'insurance') {
        data.players.forEach(p => { if (p.cards?.length) p.insuranceOffered = true; });
        data.message = 'Dealer shows an Ace. Take insurance or continue.';
    } else {
        data.message = 'Bets are locked. Hit or stand.';
    }
    runTableBots(room);
    return true;
}

function isNaturalBlackjack(cards) {
    return (cards || []).length === 2 && cardValue(cards) === 21;
}

function settleBlackjack(room) {
    const data = room.tableData;
    data.dealer.reveal = true;
    data.dealer.cards = data.dealer.cards.map(c => c.hidden ? room.deck.pop() : c);
    while (cardValue(data.dealer.cards) < 17) data.dealer.cards.push(room.deck.pop());
    const dealerValue = cardValue(data.dealer.cards);
    const dealerNatural = isNaturalBlackjack(data.dealer.cards);
    data.players.forEach(p => {
        if (!p.cards?.length || p.bet <= 0) return;
        const value = cardValue(p.cards);
        const originalBet = p.bet;
        const insurance = p.insurance || 0;
        if (insurance && dealerNatural) p.chips += insurance * 3;
        if (p.bust || value > 21) p.result = 'lose';
        else if (isNaturalBlackjack(p.cards) && !dealerNatural) { p.result = 'blackjack'; p.chips += originalBet + Math.floor(originalBet * 1.5); }
        else if (dealerValue > 21 || value > dealerValue) { p.result = 'win'; p.chips += originalBet * 2; }
        else if (value === dealerValue) { p.result = 'push'; p.chips += originalBet; }
        else p.result = 'lose';
        p.bet = 0;
        p.doneBetting = false;
    });
    data.pot = 0;
    data.phase = 'settled';
    data.message = 'Dealer settled the hand. Use Play Again for another blackjack hand.';
}

function nextBlackjackTurn(room) {
    const data = room.tableData;
    const n = data.players.length;
    for (let i = 1; i <= n; i++) {
        const idx = (data.turnIdx + i) % n;
        const p = data.players[idx];
        if (room.players[idx].connected && !p.bust && !p.stand && p.cards.length) {
            data.turnIdx = idx;
            runTableBots(room);
            return;
        }
    }
    settleBlackjack(room);
}

function holdemActivePlayers(data) {
    return data.players.filter(p => p.cards?.length && !p.folded);
}

function postBlind(data, idx, amount) {
    const p = data.players[idx];
    const paid = Math.min(amount, p.chips);
    p.chips -= paid; p.bet += paid; p.roundBet += paid; data.pot += paid;
    data.currentBet = Math.max(data.currentBet, p.roundBet);
}

function nextHoldemSeat(data, fromIdx) {
    const n = data.players.length;
    for (let i = 1; i <= n; i++) {
        const idx = (fromIdx + i) % n;
        const p = data.players[idx];
        if (p.cards?.length && !p.folded) return idx;
    }
    return fromIdx;
}

function startHoldemHand(room) {
    const data = room.tableData;
    room.deck = buildDeck();
    data.community = []; data.pot = 0; data.currentBet = 0; data.minRaise = BIG_BLIND;
    data.phase = 'preflop'; data.revealedStage = 'pre-flop';
    data.players.forEach((p, idx) => {
        p.cards = room.players[idx].connected && p.chips > 0 ? [room.deck.pop(), room.deck.pop()] : [];
        p.bet = 0; p.roundBet = 0; p.folded = false; p.acted = false; p.result = null; p.role = '';
    });
    const eligible = data.players.map((p, idx) => idx).filter(idx => room.players[idx].connected && data.players[idx].chips > 0);
    if (eligible.length < 2) { data.message = 'Need at least two players with chips.'; return; }
    data.dealerIdx = data.dealerIdx == null ? eligible[0] : nextHoldemSeat(data, data.dealerIdx);
    data.smallBlindIdx = nextHoldemSeat(data, data.dealerIdx);
    data.bigBlindIdx = nextHoldemSeat(data, data.smallBlindIdx);
    data.players[data.dealerIdx].role = 'Dealer';
    data.players[data.smallBlindIdx].role = 'Small blind';
    data.players[data.bigBlindIdx].role = 'Big blind';
    postBlind(data, data.smallBlindIdx, SMALL_BLIND);
    postBlind(data, data.bigBlindIdx, BIG_BLIND);
    data.turnIdx = nextHoldemSeat(data, data.bigBlindIdx);
    data.message = `Blinds posted: ${data.players[data.smallBlindIdx].name} ${SMALL_BLIND}, ${data.players[data.bigBlindIdx].name} ${BIG_BLIND}.`;
    runTableBots(room);
}

function holdemRoundComplete(data) {
    const active = holdemActivePlayers(data);
    return active.length <= 1 || active.every(p => p.acted && (p.roundBet === data.currentBet || p.chips === 0));
}

function advanceHoldemRound(room) {
    const data = room.tableData;
    if (holdemActivePlayers(data).length <= 1) return settleHoldem(room);
    data.players.forEach(p => { p.roundBet = 0; p.acted = false; });
    data.currentBet = 0;
    if (data.phase === 'preflop') { data.community = [room.deck.pop(), room.deck.pop(), room.deck.pop()]; data.phase = 'flop'; data.revealedStage = 'flop'; data.message = 'The flop is revealed. Betting round opened.'; }
    else if (data.phase === 'flop') { data.community.push(room.deck.pop()); data.phase = 'turn'; data.revealedStage = 'turn'; data.message = 'The turn card is revealed.'; }
    else if (data.phase === 'turn') { data.community.push(room.deck.pop()); data.phase = 'river'; data.revealedStage = 'river'; data.message = 'The river card is revealed.'; }
    else return settleHoldem(room);
    data.turnIdx = nextHoldemSeat(data, data.dealerIdx);
    runTableBots(room);
}

const RANK_VALUE = { '2':2, '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, J:11, Q:12, K:13, A:14 };
const HAND_NAMES = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight', 'Flush', 'Full House', 'Four of a Kind', 'Straight Flush'];
function combo5(cards) { const out=[]; for(let a=0;a<cards.length-4;a++)for(let b=a+1;b<cards.length-3;b++)for(let c=b+1;c<cards.length-2;c++)for(let d=c+1;d<cards.length-1;d++)for(let e=d+1;e<cards.length;e++)out.push([cards[a],cards[b],cards[c],cards[d],cards[e]]); return out; }
function evalFive(cards) {
    const vals = cards.map(c => RANK_VALUE[c.rank]).sort((a,b)=>b-a), counts = {};
    vals.forEach(v => counts[v] = (counts[v] || 0) + 1);
    const groups = Object.entries(counts).map(([v,c]) => ({ v:Number(v), c })).sort((a,b)=> b.c-a.c || b.v-a.v);
    const flush = cards.every(c => c.suit === cards[0].suit);
    const unique = [...new Set(vals)].sort((a,b)=>b-a); if (unique[0] === 14) unique.push(1);
    let straightHigh = 0; for (let i=0;i<=unique.length-5;i++) if (unique[i]-unique[i+4]===4) { straightHigh=unique[i]; break; }
    if (flush && straightHigh) return [8, straightHigh];
    if (groups[0].c === 4) return [7, groups[0].v, groups[1].v];
    if (groups[0].c === 3 && groups[1]?.c === 2) return [6, groups[0].v, groups[1].v];
    if (flush) return [5, ...vals]; if (straightHigh) return [4, straightHigh];
    if (groups[0].c === 3) return [3, groups[0].v, ...groups.slice(1).map(g=>g.v).sort((a,b)=>b-a)];
    if (groups[0].c === 2 && groups[1]?.c === 2) return [2, groups[0].v, groups[1].v, groups[2].v];
    if (groups[0].c === 2) return [1, groups[0].v, ...groups.slice(1).map(g=>g.v).sort((a,b)=>b-a)];
    return [0, ...vals];
}
function compareScore(a,b){ for(let i=0;i<Math.max(a.length,b.length);i++) if((a[i]||0)!==(b[i]||0)) return (a[i]||0)-(b[i]||0); return 0; }
function bestPokerHand(cards){ let best=null; for(const combo of combo5(cards)){ const score=evalFive(combo); if(!best||compareScore(score,best.score)>0) best={score,name:HAND_NAMES[score[0]]}; } return best||{score:[0],name:'High Card'}; }

function settleHoldem(room) {
    const data = room.tableData;
    data.phase = 'showdown';
    const active = holdemActivePlayers(data);
    let winners = active;
    if (active.length > 1) {
        let best = null;
        active.forEach(p => { const hand = bestPokerHand([...(p.cards||[]), ...(data.community||[])]); p.result = hand.name; p.score = hand.score; if(!best||compareScore(hand.score,best.score)>0){best=hand; winners=[p];} else if(compareScore(hand.score,best.score)===0) winners.push(p); });
    }
    const share = Math.floor((data.pot || 0) / Math.max(1, winners.length));
    winners.forEach(p => { p.chips += share; p.result = `${p.result || 'Winner'} +${share}`; });
    data.message = `${winners.map(p => p.name).join(', ')} won the pot.`;
    data.pot = 0;
}

function handleHoldemAction(room, playerIdx, action, amount = 0) {
    const data = room.tableData;
    if (!data || room.gameType !== 'texas_holdem' || !['preflop','flop','turn','river'].includes(data.phase) || data.turnIdx !== playerIdx) return;
    const p = data.players[playerIdx]; if (!p || p.folded || !p.cards?.length) return;
    const toCall = Math.max(0, data.currentBet - p.roundBet);
    if (action === 'fold') { p.folded = true; p.acted = true; data.message = `${p.name} folded.`; markTableSound(room, 'fold'); }
    else if (action === 'check') { if (toCall > 0) return; p.acted = true; data.message = `${p.name} checked.`; markTableSound(room, 'click'); }
    else if (action === 'call') { const pay = Math.min(toCall, p.chips); p.chips -= pay; p.bet += pay; p.roundBet += pay; data.pot += pay; p.acted = true; data.message = `${p.name} called ${pay}.`; markTableSound(room, 'bet'); }
    else if (action === 'bet' || action === 'raise') { const raiseBy = Math.max(BIG_BLIND, Number(amount || BIG_BLIND)); const totalPay = Math.min(p.chips, toCall + raiseBy); if(totalPay<=0)return; p.chips-=totalPay; p.bet+=totalPay; p.roundBet+=totalPay; data.pot+=totalPay; data.currentBet=p.roundBet; p.acted=true; data.players.forEach((op,idx)=>{ if(idx!==playerIdx && !op.folded && op.cards?.length) op.acted=false; }); data.message = `${p.name} ${action === 'raise' ? 'raised' : 'bet'} ${totalPay}.`; markTableSound(room, 'bet'); }
    if (holdemActivePlayers(data).length <= 1 || holdemRoundComplete(data)) advanceHoldemRound(room); else data.turnIdx = nextHoldemSeat(data, playerIdx);
    runTableBots(room); sendTableState(room);
}

function handleTableBet(room, playerIdx, amount) {
    const data = room.tableData;
    if (!data || room.gameType !== 'blackjack_chips') return;
    const player = data.players[playerIdx];
    if (!player || data.phase !== 'betting' || player.doneBetting) return;
    amount = Math.max(1, Math.min(Number(amount || 0), player.chips)); if (!amount) return;
    player.chips -= amount; player.bet += amount; data.pot += amount;
    data.message = `${player.name} added ${amount} to their bet. Press Done Betting when ready.`;
    markTableSound(room, 'bet');
    sendTableState(room);
}

function handleDoneBetting(room, playerIdx) {
    const data = room.tableData;
    if (!data || room.gameType !== 'blackjack_chips' || data.phase !== 'betting') return;
    const player = data.players[playerIdx]; if (!player || player.bet <= 0) return;
    player.doneBetting = true; data.message = `${player.name} is done betting.`;
    markTableSound(room, 'ready');
    dealBlackjackIfReady(room); sendTableState(room);
}

function handleBlackjackInsurance(room, playerIdx, take) {
    const data = room.tableData;
    if (!data || room.gameType !== 'blackjack_chips' || data.phase !== 'insurance') return;
    const player = data.players[playerIdx]; if (!player || !player.insuranceOffered) return;
    if (take) { const amount = Math.min(Math.floor(player.bet / 2), player.chips); player.chips -= amount; player.insurance = amount; data.pot += amount; markTableSound(room, 'bet'); } else { markTableSound(room, 'click'); }
    player.insuranceOffered = false;
    if (data.players.every((p, idx) => !room.players[idx].connected || !p.insuranceOffered)) { data.phase = 'player_turn'; data.message = 'Insurance choices are done. Hit or stand.'; runTableBots(room); }
    sendTableState(room);
}

function handleBlackjackAction(room, playerIdx, action) {
    const data = room.tableData;
    if (!data || room.gameType !== 'blackjack_chips' || data.phase !== 'player_turn' || data.turnIdx !== playerIdx) return;
    const player = data.players[playerIdx]; if (!player || player.bust || player.stand) return;
    if (action === 'hit') { markTableSound(room, 'card'); player.cards.push(room.deck.pop()); if (cardValue(player.cards) > 21) { player.bust = true; data.message = `${player.name} busted.`; nextBlackjackTurn(room); } else data.message = `${player.name} hit.`; }
    else if (action === 'stand') { markTableSound(room, 'ready'); player.stand = true; data.message = `${player.name} stands.`; nextBlackjackTurn(room); }
    runTableBots(room); sendTableState(room);
}

function resetBlackjackHand(room) {
    if (!room.tableData || room.gameType !== 'blackjack_chips') return;
    room.deck = buildDeck();
    room.tableData.players.forEach(p => { p.bet=0; p.cards=[]; p.doneBetting=false; p.stand=false; p.bust=false; p.result=null; p.insurance=0; p.insuranceOffered=false; });
    room.tableData.dealer = { cards: [] }; room.tableData.pot = 0; room.tableData.phase = 'betting'; room.tableData.message = 'Place your blackjack bet, then press Done Betting.';
    autoBlackjackBots(room); sendTableState(room);
}

function applyLcrDice(room, playerIdx, dice) {
    const data = room.tableData; const player = data.players[playerIdx]; const n = data.players.length;
    for (const face of dice) { if (face === 'L') { player.chips--; data.players[(playerIdx - 1 + n) % n].chips++; } if (face === 'R') { player.chips--; data.players[(playerIdx + 1) % n].chips++; } if (face === 'C') { player.chips--; data.centerChips++; } }
    data.diceRolling = false;
    const active = data.players.filter(p => p.chips > 0);
    if (active.length === 1) { room.state = 'over'; room.winner = active[0].name; data.message = `${active[0].name} wins LCR!`; sendTableState(room); broadcast(room, { type:'gameover', winner: active[0].name, gameType: room.gameType, reason: 'lcr' }); }
    else { data.turnIdx = currentPlayerIdx({ ...data, turnIdx: (playerIdx + 1) % n }, room); data.message = `${player.name} rolled ${dice.join(' ')}. Chips passed.`; sendTableState(room); runTableBots(room); }
}

function handleLcrRoll(room, playerIdx) {
    const data = room.tableData;
    if (!data || room.gameType !== 'left_center_right' || data.turnIdx !== playerIdx || data.diceRolling) return;
    const player = data.players[playerIdx]; if (!player || player.chips <= 0) return;
    const diceCount = Math.min(3, player.chips);
    const faces = ['L', 'C', 'R', '•', '•', '•'];
    const finalDice = Array.from({ length: diceCount }, () => faces[Math.floor(Math.random() * faces.length)]);
    data.diceRolling = true; data.dice = Array.from({ length: diceCount }, () => '-'); data.message = `${player.name} is rolling...`; markTableSound(room, 'roll'); sendTableState(room);
    finalDice.forEach((face, i) => setTimeout(() => { if (room.tableData !== data) return; data.dice[i] = face; data.message = `${player.name} rolled ${data.dice.join(' ')}...`; sendTableState(room); }, 500 + i * 250));
    setTimeout(() => { if (room.tableData === data) applyLcrDice(room, playerIdx, finalDice); }, 500 + finalDice.length * 250 + 1000);
}

function runTableBots(room) {
    const data = room.tableData;
    if (!data || room.state !== 'playing') return;
    if (room.gameType === 'blackjack_chips') {
        autoBlackjackBots(room);
        if (data.phase === 'betting') dealBlackjackIfReady(room);
        if (data.phase === 'insurance') { data.players.forEach((p, idx) => { if (room.players[idx].isBot && p.insuranceOffered) p.insuranceOffered = false; }); if (data.players.every((p, idx) => !room.players[idx].connected || !p.insuranceOffered)) data.phase = 'player_turn'; }
        if (data.phase === 'player_turn' && room.players[data.turnIdx]?.isBot) setTimeout(() => { if (room.tableData !== data || data.phase !== 'player_turn' || !room.players[data.turnIdx]?.isBot) return; const botIdx = data.turnIdx; handleBlackjackAction(room, botIdx, cardValue(data.players[botIdx].cards) < 16 ? 'hit' : 'stand'); botMoveChat(room, botIdx, 'bet'); }, 700);
    }
    if (room.gameType === 'left_center_right' && room.players[data.turnIdx]?.isBot && !data.diceRolling) setTimeout(() => { const botIdx = data.turnIdx; handleLcrRoll(room, botIdx); botMoveChat(room, botIdx, 'roll'); }, 800);
    if (room.gameType === 'texas_holdem' && ['preflop','flop','turn','river'].includes(data.phase) && room.players[data.turnIdx]?.isBot) setTimeout(() => { if (room.tableData !== data || !room.players[data.turnIdx]?.isBot) return; const p = data.players[data.turnIdx]; const toCall = Math.max(0, data.currentBet - p.roundBet); const botIdx = data.turnIdx; handleHoldemAction(room, botIdx, toCall ? 'call' : 'check'); botMoveChat(room, botIdx, 'bet'); }, 900);
}

function handleBingoDraw(room, playerIdx) {
    const data = room.tableData;
    if (!data || room.gameType !== 'bingo' || playerIdx !== 0 || data.bingoDrawing) return;
    const next = room.bingoMode === 'easy' ? Math.floor(Math.random() * 75) + 1 : data.drawPile.shift();
    if (!next) return;
    data.bingoDrawing = true;
    data.calledNumber = '-';
    data.message = 'Bingo picker is rolling...';
    markTableSound(room, 'roll');
    sendTableState(room);
    setTimeout(() => {
        if (room.tableData !== data) return;
        data.bingoDrawing = false;
        data.calledNumber = next;
        data.calledNumbers.push(next);
        data.players.forEach((p, idx) => {
            if (room.players[idx]?.isBot) {
                const card = data.bingoCards[idx];
                if (card?.some(row => row.includes(next)) && !data.marked[idx].includes(next)) { data.marked[idx].push(next); botMoveChat(room, idx, 'bingo'); }
            }
        });
        data.message = `Number ${next} called — MARK YOUR CARDS!`;
        markTableSound(room, 'ding');
        sendChat(room, 'Server', data.message);
        sendTableState(room);
    }, 800);
}

function handleBingoMark(room, playerIdx, number) {
    const data = room.tableData;
    if (!data || room.gameType !== 'bingo') return;
    number = Number(number);
    if (!data.calledNumbers.includes(number)) return;
    const card = data.bingoCards[playerIdx];
    if (!card || !card.some(row => row.includes(number))) return;
    if (!data.marked[playerIdx].includes(number)) { data.marked[playerIdx].push(number); markTableSound(room, 'ready'); }
    data.message = `${room.players[playerIdx].name} marked ${number}.`;
    if (bingoHasWin(card, data.marked[playerIdx])) {
        room.state = 'over';
        room.winner = room.players[playerIdx].name;
        data.message = `${room.winner} got BINGO!`;
        broadcast(room, { type:'gameover', winner: room.winner, gameType: room.gameType });
    }
    sendTableState(room);
}

function startTableGame(room) {
    room.state = 'playing';
    room.deck = buildDeck();
    room.discard = [];
    room.players.forEach(p => {
        p.hand = [];
        p.connected = true;
    });

    if (room.gameType === 'blackjack_chips') {
        room.tableData = {
            players: makeChipPlayers(room, 500),
            dealer: { cards: [] },
            pot: 0,
            phase: 'betting',
            turnIdx: 0,
            message: 'Place your blackjack bet, then press Done Betting. Starting balance: 500.',
        };
    } else if (room.gameType === 'texas_holdem') {
        room.tableData = {
            players: makeChipPlayers(room, 1000),
            community: [],
            pot: 0,
            phase: 'preflop',
            turnIdx: 0,
            dealerIdx: null,
            smallBlindIdx: null,
            bigBlindIdx: null,
            currentBet: 0,
            minRaise: BIG_BLIND,
            revealedStage: 'pre-flop',
            message: 'Texas Hold\'em is dealing. Blinds post automatically.',
        };
        startHoldemHand(room);
    } else if (room.gameType === 'left_center_right') {
        room.tableData = {
            players: makeChipPlayers(room, 3),
            centerChips: 0,
            phase: 'rolling',
            turnIdx: currentPlayerIdx({ players: makeChipPlayers(room, 3), turnIdx: 0 }, room),
            dice: [],
            message: 'Roll LCR dice. L passes left, R passes right, C goes to center.',
        };
    } else if (room.gameType === 'bingo') {
        room.tableData = {
            players: makeChipPlayers(room, 0).map(p => ({ ...p, chips: null })),
            calledNumber: null,
            calledNumbers: [],
            drawPile: shuffle(Array.from({ length: 75 }, (_, i) => i + 1)),
            bingoCards: room.players.map(() => randomBingoCard()),
            marked: room.players.map(() => ['FREE']),
            phase: 'marking',
            message: `Bingo cards are dealt in ${(room.bingoMode || 'hard').toUpperCase()} mode. Host draws numbers; everyone marks their own card.`,
        };
    } else if (room.gameType === 'chat_room') {
        room.tableData = {
            players: makeChipPlayers(room, 0).map(p => ({ ...p, chips: null })),
            phase: 'chatting',
            message: 'Chat room is open. Use the chat hub, and the host can go back to select a game.',
        };
    } else {
        room.tableData = {
            players: makeChipPlayers(room, 0).map(p => ({ ...p, chips: null })),
            phase: 'playing',
            message: `${prettyGameName(room.gameType)} table is live.`,
        };
    }

    sendChat(room, 'Server', `${prettyGameName(room.gameType)} started.`);
    sendTableState(room);
    runTableBots(room);
}

function startGame(room) {
    if (room.players.length < 2 && room.gameType !== 'chat_room') return;
    if (room.gameType !== 'crazy_eights') {
        startTableGame(room);
        return;
    }
    room.state = 'playing';
    room.deck = buildDeck();
    room.discard = [];
    room.turnIdx = 0;
    room.dir = 1;
    room.hasDrawn = false;
    room.winner = null;
    room.players.forEach(p => { 
        p.hand = draw(room, HAND_SIZE); 
        p.connected = true; 
    });
    
    let startCard;
    do {
        startCard = room.deck.pop();
    } while (startCard.rank === '8');

    room.discard.push(startCard);
    room.activeSuit = startCard.suit;
    room.activeRank = startCard.rank;
    
    sendChat(room, 'Server', 'Crazy Eights started with a standard 52-card deck. All 8s are wild! ' + room.players.map(p=>p.name).join(', '));
    sendState(room);
}

function runBotTurn(room) {
    const botPlayer = room.players[room.turnIdx];
    if (!botPlayer || !botPlayer.isBot) return;

    const thinkingTime = (Math.random() * (2.0 - 1.0) + 1.0);
    const delayMs = thinkingTime * 1000;

    setTimeout(() => {
        let playIdx = botPlayer.hand.findIndex(c => canPlay(c, room.activeSuit, room.activeRank));
        if (playIdx !== -1) {
            const card = botPlayer.hand[playIdx];
            let chosenSuit = room.activeSuit;

            if (card.rank === '8') {
                const counts = { Spades: 0, Hearts: 0, Diamonds: 0, Clubs: 0 };
                botPlayer.hand.forEach(c => {
                    if (counts[c.suit] !== undefined) counts[c.suit]++;
                });
                chosenSuit = Object.keys(counts).reduce((a, b) => counts[a] > counts[b] ? a : b, 'Spades');
            }
            const botIdx = room.turnIdx;
            handlePlay(room, botIdx, playIdx, chosenSuit);
            botMoveChat(room, botPlayer, 'play');
        } else {
            const botIdx = room.turnIdx;
            handleDraw(room, botIdx);
            botMoveChat(room, botPlayer, 'draw');
            let lastCardIdx = botPlayer.hand.length - 1;
            if (canPlay(botPlayer.hand[lastCardIdx], room.activeSuit, room.activeRank)) {
                handlePlay(room, room.turnIdx, lastCardIdx, room.activeSuit);
                botMoveChat(room, botPlayer, 'play');
            } else {
                handlePass(room, room.turnIdx);
                botMoveChat(room, botPlayer, 'pass');
            }
        }
    }, delayMs);
}

wss.on('connection', (ws) => {
    let myRoom = null;
    let myIdx = -1;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }

        if (msg.type === 'set_cpus') {
            if (!myRoom || myIdx !== 0) return;
            myRoom.players = myRoom.players.filter(p => !p.isBot);
            for (let i = 0; i < msg.count; i++) {
                const persona = getBotPersona(i);
                myRoom.players.push({
                    name: persona.name,
                    personality: persona.personality,
                    isBot: true,
                    connected: true,
                    hand: []
                });
            }
            broadcast(myRoom, lobbyPayload(myRoom));
            return;
        }
        
        if (msg.type === 'join') {
            const code = (msg.code || '').toUpperCase().trim();
            const name = (msg.name || 'Player').slice(0, 20).trim();
            
            if (!code || code.length < 2) {
                ws.send(JSON.stringify({ type:'error', msg:'Invalid room code.' }));
                return;
            }

            if (!rooms[code]) rooms[code] = makeRoom(code);
            const room = rooms[code];
            const existingPlayer = room.players.find(p => p.name.toLowerCase() === name.toLowerCase());
            
            if (existingPlayer) {
                if (existingPlayer.connected) {
                    ws.send(JSON.stringify({ type:'error', msg:'Name taken!' }));
                    return;
                } else {
                    existingPlayer.ws = ws;
                    existingPlayer.connected = true;
                    myIdx = room.players.indexOf(existingPlayer);
                }
            } else {
                if (room.state !== 'lobby') {
                    ws.send(JSON.stringify({ type:'error', msg:'Game in progress.' }));
                    return;
                }
                if (room.players.length >= MAX_PLAYERS) {
                    ws.send(JSON.stringify({ type:'error', msg:'Room full!' }));
                    return;
                }
                myIdx = room.players.length;
                room.players.push({ id: myIdx, name, ws, hand:[], connected:true, isBot:false });
            }
            myRoom = room;
            ws.send(JSON.stringify({ 
                type: 'joined', 
                code, 
                name, 
                yourIdx: myIdx, 
                isHost: myIdx === 0, 
                playerCount: room.players.length,
                gameType: room.gameType,
                chatFilterEnabled: room.chatFilterEnabled,
                gameplayMusicEnabled: room.gameplayMusicEnabled,
                bingoMode: room.bingoMode || 'hard'
            }));
            sendChat(room, 'Server', `${name} joined.`);
            broadcast(room, lobbyPayload(room));
            if (room.state === 'playing') {
                if (room.gameType === 'crazy_eights') sendState(room);
                else sendTableState(room);
            }
            return;
        }

        if (msg.type === 'set_room_options') {
            if (myIdx !== 0 || !myRoom) return;
            myRoom.chatFilterEnabled = !!msg.chatFilterEnabled;
            myRoom.gameplayMusicEnabled = !!msg.gameplayMusicEnabled;
            if (msg.bingoMode === 'easy' || msg.bingoMode === 'hard') myRoom.bingoMode = msg.bingoMode;
            broadcast(myRoom, lobbyPayload(myRoom));
            sendChat(myRoom, 'Server', `Chat filter ${myRoom.chatFilterEnabled ? 'enabled' : 'disabled'}. Gameplay music ${myRoom.gameplayMusicEnabled ? 'enabled' : 'disabled'}. Bingo mode ${(myRoom.bingoMode || 'hard').toUpperCase()}.`);
            return;
        }

        if (msg.type === 'set_game_type') {
            if (myIdx !== 0 || !myRoom || myRoom.state !== 'lobby') return;
            const nextGame = VALID_GAME_TYPES.includes(msg.gameType) ? msg.gameType : 'crazy_eights';
            myRoom.gameType = nextGame;
            broadcast(myRoom, lobbyPayload(myRoom));
            sendChat(myRoom, 'Server', `Host selected ${prettyGameName(nextGame)}.`);
            return;
        }

        if (msg.type === 'start') {
            if (myIdx !== 0 || !myRoom) return;
            startGame(myRoom);
            return;
        }

        if (myRoom.gameType === 'crazy_eights' && msg.type === 'play') { handlePlay(myRoom, myIdx, msg.cardIdx, msg.chosenSuit || msg.chosenColor); return; }
        if (myRoom.gameType === 'crazy_eights' && msg.type === 'draw') { handleDraw(myRoom, myIdx); return; }
        if (myRoom.gameType === 'crazy_eights' && msg.type === 'pass') { handlePass(myRoom, myIdx); return; }
        if (msg.type === 'table_bet') { handleTableBet(myRoom, myIdx, msg.amount); return; }
        if (msg.type === 'done_betting') { handleDoneBetting(myRoom, myIdx); return; }
        if (msg.type === 'bj_insurance') { handleBlackjackInsurance(myRoom, myIdx, !!msg.take); return; }
        if (msg.type === 'table_play_again') { if (myIdx === 0 && myRoom?.gameType === 'blackjack_chips') resetBlackjackHand(myRoom); if (myIdx === 0 && myRoom?.gameType === 'texas_holdem') { startHoldemHand(myRoom); sendTableState(myRoom); } return; }
        if (msg.type === 'holdem_action') { handleHoldemAction(myRoom, myIdx, msg.action, msg.amount); return; }
        if (msg.type === 'bj_hit') { handleBlackjackAction(myRoom, myIdx, 'hit'); return; }
        if (msg.type === 'bj_stand') { handleBlackjackAction(myRoom, myIdx, 'stand'); return; }
        if (msg.type === 'lcr_roll') { handleLcrRoll(myRoom, myIdx); return; }
        if (msg.type === 'bingo_draw_next') { handleBingoDraw(myRoom, myIdx); return; }
        if (msg.type === 'bingo_mark') { handleBingoMark(myRoom, myIdx, msg.number); return; }
        if (msg.type === 'chat') {
            const text = (msg.text||'').slice(0,200);
            const speaker = myRoom.players[myIdx];
            sendChat(myRoom, speaker.name, text);
            if (!speaker.isBot) {
                rememberRoomChat(myRoom, speaker.name, text, 'user');
                maybeRunAIChat(myRoom, speaker.name, text);
            }
            return;
        }
        if (msg.type === 'clear_chat') {
            if (!myRoom || myIdx !== 0) return;
            broadcast(myRoom, { type:'chat_cleared', by: myRoom.players[myIdx].name });
            sendChat(myRoom, 'Server', `${myRoom.players[myIdx].name} cleared chat.`);
            return;
        }
        
        if (msg.type === 'restart') {
            if (myIdx !== 0 || !myRoom) return;
            myRoom.state = 'lobby';
            myRoom.tableData = null;
            myRoom.players.forEach(p => { p.hand = []; });
            broadcast(myRoom, lobbyPayload(myRoom));
            return;
        }
    });

    ws.on('close', () => {
        if (!myRoom || myIdx < 0) return;
        const room = myRoom;
        if (room.players[myIdx]) {
            room.players[myIdx].connected = false;
            sendChat(room, 'Server', `${room.players[myIdx].name} disconnected.`);
            if (room.state === 'lobby') {
                room.players = room.players.filter((p, idx) => idx === 0 || p.connected || p.isBot);
            }
            
            if (room.state === 'playing' && room.gameType === 'crazy_eights' && room.turnIdx === myIdx) {
                sendChat(room, 'Server', `Skipping ${room.players[myIdx].name}'s turn...`);
                nextTurn(room);
            }

            const anyoneLeft = room.players.some(p => p.connected && !p.isBot);
            if (!anyoneLeft) {
                delete rooms[room.code];
                return;
            }
            broadcast(room, lobbyPayload(room));
            if (room.state === 'playing') {
                if (room.gameType === 'crazy_eights') sendState(room);
                else sendTableState(room);
            }
        }
    });
});

httpServer.listen(PORT, () => console.log(`Tabletop Online server running on port ${PORT}`));

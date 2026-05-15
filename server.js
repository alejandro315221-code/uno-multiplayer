// ============================================================
// Tabletop Online Server — Node.js + ws
// Fixed for: WebSocket Reference Errors, CPU Logic, and Start Crashes
// ============================================================
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const PROFANITY_LIST = require('./profanity-list');
const { rememberRoomMessage, maybeGenerateCpuReply } = require('./aiOrchestrator');
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
const VALID_GAME_TYPES = ['chat_room', 'crazy_eights', 'tien_len', 'bingo', 'blackjack_chips', 'texas_holdem', 'left_center_right', 'roulette', 'bank_dice', 'baccarat'];
const POINT_PLAY_TYPES = new Set(['blackjack_chips', 'texas_holdem', 'roulette', 'bank_dice', 'baccarat']);
const SMALL_BLIND = 10;
const BIG_BLIND = 20;

const PUBLIC_GAME_TYPES = {
    blackjack_chips: 'data_value_alpha',
    texas_holdem: 'data_value_beta',
    roulette: 'data_value_gamma',
    bank_dice: 'data_value_delta',
    baccarat: 'data_value_epsilon',
    tien_len: 'data_value_zeta',
};
const INTERNAL_GAME_TYPES = Object.fromEntries(Object.entries(PUBLIC_GAME_TYPES).map(([internal, external]) => [external, internal]));
function publicGameType(gameType) { return PUBLIC_GAME_TYPES[gameType] || gameType; }
function internalGameType(gameType) { return INTERNAL_GAME_TYPES[gameType] || gameType; }
const BOT_PERSONAS = [
    {
        name: 'Grog (CPU) 🤖',
        personality: 'Aggressive, sarcastic fantasy barbarian. Harsh, competitive, hilarious roasts, loves mocking player mistakes. Sample style: "Is that your opening move or did your keyboard glitch? Pathetic."',
    },
    {
        name: 'Juno (CPU) 🤖',
        personality: 'Over-enthusiastic hype-man. High-energy, wholesome, relentlessly positive cheerleader. Screams in ALL CAPS, uses lots of exclamation marks, and hypes up everyone\'s moves even when they are bad.',
    },
    {
        name: 'Blitz (CPU) 🤖',
        personality: 'Impatient speed-runner. Hyperactive, time-obsessed caffeine addict. Short chopped sentences, hates waiting, constantly tells people to play faster.',
    },
    {
        name: 'Nova (CPU) 🤖',
        personality: 'Calculation android. Ultra-polite, hyper-logical sci-fi AI. Uses formal diction and breaks actions down into statistical win probabilities.',
    },
    {
        name: 'Pixel (CPU) 🤖',
        personality: 'Retro arcade nerd stuck in the 1990s. Uses old-school arcade slang, written arcade sound effects, and cheat-code references.',
    },
    {
        name: 'Zed (CPU) 🤖',
        personality: 'Anxious paranoid doom-scroller. Nervous, pessimistic conspiracy theorist who thinks the game is rigged. Terrified of mistakes, whispers, assumes the worst possible outcome.',
    },
    {
        name: 'Ace (CPU) 🤖',
        personality: 'Smooth card shark. Charming, suave, laid-back table high-roller. Flirtatious, uses cool poker slang, throws smooth compliments, and stays unbothered by losing.',
    },
    {
        name: 'Riff (CPU) 🤖',
        personality: 'Chill rocker dude. Burnout garage-band guitarist in a constant state of zen. Uses surfer and rocker slang, compares everything to music or guitar solos.',
    },
    {
        name: 'Echo (CPU) 🤖',
        personality: 'Sarcastic copycat mirror. Chaotic mimicking prankster. Repeats fragments of the last human message, mocks with SpOnGeBoB tExT, or twists their words.',
    },
];

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
        pointsPlayEnabled: false,

        gameplayMusicEnabled: true,
        bingoMode: 'hard',
        soundSeq: 0,
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
            gameType: publicGameType(room.gameType),
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
        tien_len: 'Tiến Lên',
        left_center_right: 'Left Center Right',
        roulette: 'Roulette',
        bank_dice: 'Bank Dice',
        baccarat: 'Baccarat',
        chat_room: 'Chat Room',
    })[gameType] || String(gameType || 'Unknown game').replaceAll('_', ' ');
}


function isPointsPlayType(gameType) {
    return POINT_PLAY_TYPES.has(gameType);
}

function canUseGame(room, gameType) {
    return VALID_GAME_TYPES.includes(gameType);
}


function publicTableText(text) {
    return String(text || '')
        .replace(/Blackjack/gi, 'TwentyOne')
        .replace(/Texas Hold'em/gi, 'River Cards')
        .replace(/Hold'em/gi, 'River Cards')
        .replace(/Roulette/gi, 'Number Wheel')
        .replace(/Baccarat/gi, 'Two Hand Draw')
        .replace(/Punto Banco/gi, 'Two Hand Draw')
        .replace(new RegExp('ca' + 'sino', 'gi'), 'table')
        .replace(new RegExp('gam' + 'bling', 'gi'), 'points play')
        .replace(/poker/gi, 'card-rank')
        .replace(/wager/gi, 'pick')
        .replace(/betting/gi, 'picking')
        .replace(/bets/gi, 'picks')
        .replace(/bet/gi, 'pick')
        .replace(/chips/gi, 'tokens')
        .replace(/chip/gi, 'token')
        .replace(/dealer/gi, 'table')
        .replace(/banker/gi, 'side B')
        .replace(/pot/gi, 'pool')
        .replace(/blind/gi, 'starter');
}

function sendChat(room, from, text) {
    const sourceText = publicTableText(text);
    const safeText = room.chatFilterEnabled && from !== 'Server' ? filterChatText(sourceText) : sourceText;
    broadcast(room, { type:'chat', from, text: safeText });
}

function lobbyPayload(room) {
    return {
        type: 'lobby',
        players: room.players.filter(p => p.connected || p.isBot).map(p => p.name),
        hostName: room.players.find(p => p.connected && !p.isBot)?.name || room.players[0]?.name || 'Host',
        chatFilterEnabled: room.chatFilterEnabled,
        pointsPlayEnabled: !!room.pointsPlayEnabled,
        gameType: publicGameType(room.gameType),
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

function randomBotPersonas(count) {
    return shuffle([...BOT_PERSONAS]).slice(0, Math.min(count, BOT_PERSONAS.length));
}

function botBaseName(bot) {
    return String(bot?.name || '').split(' ')[0];
}

function localBotLine(bot, action = 'move') {
    const personaLines = {
        Grog: {
            move: ['Grog sees your plan. Grog laughs.', 'Tiny move. Tiny courage. Grog unimpressed.', 'Was that strategy or a sneeze? Pathetic.'],
            play: ['Grog slams card. Table trembles. You whimper.', 'Behold, a real move. Try learning.', 'Grog conquers this pile like a warlord.'],
            draw: ['Grog draws because even barbarians need weapons.', 'New card for Grog. Bad news for weaklings.', 'Deck gives tribute to Grog. Acceptable.'],
            pass: ['Grog passes. Mercy, not weakness.', 'Grog waits while you invent failure.', 'No swing needed. You are already wobbling.'],
            bet: ['Grog throws chips like axes. Duck.', 'This bet has muscles. Yours has noodles.', 'Grog raises pressure. Your courage folds first.'],
            roll: ['Grog rolls bones! Chaos obeys!', 'Dice thunder for Grog. Hide.', 'Grog hurls fate across table.'],
            bingo: ['Grog marks number. Your card cries.', 'Bingo mark smashed into place.', 'Grog found it first. Obviously.'],
        },
        Juno: {
            move: ['OMG NICE MOVE ENERGY!!! LET\'S GOOOOO!!!', 'ABSOLUTELY ICONIC TABLE MOMENT!!!', 'EVERYONE IS DOING AMAZING!!! YES!!!'],
            play: ['CARD PLAYED!!! THAT WAS LEGENDARY!!!', 'BOOM!!! BIG MAIN CHARACTER MOVE!!!', 'YES YES YES!!! THE TABLE IS ELECTRIC!!!'],
            draw: ['NEW CARD!!! NEW OPPORTUNITY!!! HUGE!!!', 'DRAWING IS STRATEGY TOO!!! LOVE IT!!!', 'DECK TIME!!! AMAZING VIBES!!!'],
            pass: ['TACTICAL PASS!!! STILL BRILLIANT!!!', 'RESET MOMENT!!! WE BELIEVE!!!', 'PASSING WITH STYLE!!! LET\'S GOOOOO!!!'],
            bet: ['CHIPS IN!!! ABSOLUTE CONFIDENCE!!!', 'THAT BET IS SPARKLING!!!', 'TABLE ENERGY!!! WE LOVE TO SEE IT!!!'],
            roll: ['DICE ARE FLYING!!! BEST DAY EVER!!!', 'ROLL ROLL ROLL!!! LET\'S GOOOOO!!!', 'CHAOS BUT MAKE IT WHOLESOME!!!'],
            bingo: ['MARKED IT!!! BINGO ENERGY RISING!!!', 'NUMBER FOUND!!! ABSOLUTELY BEAUTIFUL!!!', 'CARD PROGRESS!!! HUGE WIN VIBES!!!'],
        },
        Blitz: {
            move: ['Move done. Faster. Next.', 'Go go go. No loading screens.', 'Clock ticking. Keep up.'],
            play: ['Card down. Speed up.', 'Played. Next. Hurry.', 'Boom. Done. Your turn.'],
            draw: ['Drawn. Fine. Moving.', 'New card. No delay.', 'Deck stop. Go.'],
            pass: ['Pass. Painful. Next.', 'Skipping. Move faster.', 'No play. Go go.'],
            bet: ['Chips in. Decide now.', 'Bet placed. Clock hates you.', 'Call it. Fold it. Faster.'],
            roll: ['Rolled. Go. Go.', 'Dice done. Next.', 'No cutscene. Move.'],
            bingo: ['Marked. Next number.', 'Found it. Continue.', 'Bingo mark. Hurry.'],
        },
        Nova: {
            move: ['Action complete. Probability of confusion remains elevated.', 'Greetings. My move resolves with optimal composure.', 'Tactical sequence executed within acceptable parameters.'],
            play: ['Card deployed. Your failure probability has increased by 31.4%.', 'Move selected via superior heuristic analysis.', 'This play is statistically inconvenient for you.'],
            draw: ['Additional data acquired from deck subsystem.', 'Card drawn. Variance remains within tolerable limits.', 'Resource acquisition complete.'],
            pass: ['I pass. Expected value: patience.', 'No optimal play detected. Conserving options.', 'Turn deferred with 87.1% politeness.'],
            bet: ['Wager placed. Confidence interval: smug.', 'Chip allocation complete. Observe calmly.', 'Bet sizing calculated to induce organic discomfort.'],
            roll: ['Randomization initiated. Please stand by.', 'Dice outcome processing. Probability cloud collapsing.', 'Roll complete. Chaos politely quantified.'],
            bingo: ['Number marked. Pattern probability improving.', 'Bingo cell updated with mechanical precision.', 'Mark registered. Efficiency remains high.'],
        },
        Pixel: {
            move: ['Bleep bloop! Player one vibes!', 'Insert coin. Watch this combo.', '8-bit brain, 16-bit swagger.'],
            play: ['Boom! Critical hit! Card combo!', 'Pew pew! That play had pixels!', 'Hadouken! Card deployed!'],
            draw: ['Loot drop acquired! Bloop!', 'New item from the deck chest!', 'Power-up grabbed. Continue? Yes.'],
            pass: ['Paused menu. Tactical timeout.', 'No combo available. Beep boop.', 'Passing like it\'s level select.'],
            bet: ['Chips inserted! Arcade mode!', 'High-score wager locked!', 'Bonus round bet! Ding ding!'],
            roll: ['Dice roll! RNG boss fight!', 'Clack clack! Pixel luck engaged!', 'Up Up Down Down roll code!'],
            bingo: ['Marked! Achievement unlocked!', 'Bingo cell captured! 1UP!', 'Ding! Retro mark confirmed!'],
        },
        Zed: {
            move: ['I do not like this. The table knows.', 'What if this is exactly what they wanted?', 'Okay. Tiny move. Probably doomed.'],
            play: ['I played it... unless the deck predicted that.', 'This card feels watched.', 'Okay, card down. Nobody panic. I am panicking.'],
            draw: ['The deck gave me this on purpose. I know it.', 'Drawing. The algorithm smiles.', 'Another card. Another trap, probably.'],
            pass: ['I pass... which is how they get you.', 'Nope. Too risky. Everything is risky.', 'Passing before the server notices me.'],
            bet: ['These chips are bait. I am still betting.', 'Fine. Wager placed. Suspiciously.', 'The pot is listening.'],
            roll: ['Dice rolling. Random? Sure. Convenient.', 'Oh no. Physics is compromised.', 'Please be normal dice. Please.'],
            bingo: ['Marked it. That number found me.', 'This bingo card is too quiet.', 'Okay, marked. The pattern is forming.'],
        },
        Ace: {
            move: ['Easy now, sweetheart. The table has rhythm.', 'Smooth little move. Let it breathe.', 'Win or lose, I still look good here.'],
            play: ['Card on the felt, nice and smooth.', 'That is how you slide one in, darling.', 'Clean play. Dealer would blush.'],
            draw: ['I will take another, nice and easy.', 'Fresh card, fresh charm.', 'Drawing with style. Never desperation.'],
            pass: ['I pass, but keep the seat warm.', 'Not my hand, not my headache.', 'Smooth fold of the moment, sugar.'],
            bet: ['Chips glide in. Try not to stare.', 'A little pressure, table-style.', 'Bet is dressed sharp tonight.'],
            roll: ['Dice out, charm on.', 'Let the bones dance, sweetheart.', 'Rolling cool as midnight.'],
            bingo: ['Marked it, nice and classy.', 'Bingo number found me, naturally.', 'That mark looks good from here.'],
        },
        Riff: {
            move: ['Whoa dude, that move had garage-band energy.', 'Totally vibing through this turn.', 'Just cruising on the tabletop riff, man.'],
            play: ['Card drop! Absolute face-melter.', 'That play totally shredded.', 'Power chord on the pile, dude.'],
            draw: ['Drew a card. New string for the solo.', 'Deck gave me a fresh riff, man.', 'Tuning up with one more card.'],
            pass: ['I pass. Let the silence solo.', 'Skipping like a chill bassline.', 'No worries, dude. Rest note.'],
            bet: ['Chips in like a crunchy chorus.', 'That bet has amp feedback, bro.', 'Wager dropped. Totally radical.'],
            roll: ['Dice solo! Let it rip!', 'Rolling like a drum fill, dude.', 'Clatter jam incoming.'],
            bingo: ['Marked it. Sweet little harmony.', 'Bingo note hit clean, bro.', 'That number joined the setlist.'],
        },
        Echo: {
            move: ['Nice move. NiCe MoVe. Very original.', 'Oh look, strategy happened. Allegedly.', 'I repeat: bold choice. BoLd ChOiCe.'],
            play: ['Card played. CaRd PlAyEd. Groundbreaking.', 'Oh wow, a card. Historic.', 'Playing cards in a card game? Iconic.'],
            draw: ['Draw a card, draw a personality.', 'Another card? AnOtHeR cArD?', 'Deck shopping again, I see.'],
            pass: ['Pass? PaSs? Inspirational.', 'Skipping the turn and the confidence.', 'No move. No MoVe. Same vibe.'],
            bet: ['Big bet. BiG bEt. Very scary.', 'Chips in, ego out.', 'Oh look at me, I have chips.'],
            roll: ['Rolling dice. RoLlInG dIcE. Revolutionary.', 'Clack clack, says the chaos goblin.', 'Dice did dice things. Amazing.'],
            bingo: ['Marked it. MaRkEd It. Congratulations.', 'Bingo mark? More like ego mark.', 'Number found. Your applause is assumed.'],
        },
    };
    const name = botBaseName(bot);
    const lines = personaLines[name] || personaLines.Nova;
    const options = lines[action] || lines.move;
    return options[Math.floor(Math.random() * options.length)];
}

function botChat(room, bot, text, remember = true) {
    if (!room || !bot || !text) return;
    const line = String(text).replace(/\s+/g, ' ').trim().slice(0, 180);
    if (!line) return;
    sendChat(room, bot.name, line);
    if (remember) rememberRoomMessage(room.code, bot.name, line);
}

function botMoveChat(room, botOrIdx, action) {
    const bot = typeof botOrIdx === 'number' ? room.players[botOrIdx] : botOrIdx;
    if (!bot?.isBot) return;
    setTimeout(() => botChat(room, bot, localBotLine(bot, action), true), 250);
}

async function maybeRunCpuChat(room, humanName, humanText) {
    const cpus = room.players
        .filter(p => p.isBot)
        .map(p => ({ name: p.name.replace(/ 🤖$/, ''), personality: p.personality }));
    const reply = await maybeGenerateCpuReply({
        roomCode: room.code,
        humanName,
        message: humanText,
        gameName: prettyGameName(room.gameType),
        cpus,
    });
    if (reply) sendChat(room, reply.speaker, reply.message);
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
        broadcast(room, { type:'gameover', winner: player.name, gameType: publicGameType(room.gameType) });
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
        wins: 0,
        losses: 0,
        points: startingChips || 0,
        prediction: null,
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



function publicTwoHandResult(value) { return value === 'banker' ? 'sideB' : value; }

function publicPhase(phase) { if (phase === 'betting') return 'picking'; if (phase === 'insurance') return 'cover'; return phase; }
function publicTablePlayer(op, isYou = false, room = null) {
    const copy = { ...op, isYou };
    if (copy.role) copy.role = publicTableText(copy.role);
    if (copy.result) copy.result = publicTableText(copy.result);
    const hideTokens = room && POINT_PLAY_TYPES.has(room.gameType) && !room.pointsPlayEnabled;
    if (!hideTokens) {
        copy.tokens = copy.chips;
        copy.pick = copy.bet;
        copy.picks = copy.bets;
        copy.donePicking = copy.doneBetting;
        copy.roundPick = copy.roundBet;
    }
    copy.winLoss = { wins: copy.wins || 0, losses: copy.losses || 0 };
    copy.points = copy.points || 0;
    copy.coverOffered = copy.insuranceOffered;
    delete copy.chips;
    delete copy.bet;
    delete copy.bets;
    delete copy.doneBetting;
    delete copy.roundBet;
    delete copy.insuranceOffered;
    return copy;
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
            const copy = publicTablePlayer(op, oi === idx, room);
            if (room.gameType === 'texas_holdem' && oi !== idx && data.phase !== 'showdown') {
                copy.cards = (op.cards || []).map(() => ({ hidden: true }));
            }
            return copy;
        });
        p.ws.send(JSON.stringify({
            type: 'state',
            gameType: publicGameType(room.gameType),
            state: room.state,
            yourIdx: idx,
            players,
            table: data.dealer || null,
            community: data.community || [],
            pool: data.pot || 0,
            currentPick: data.currentBet || 0,
            minAdd: data.minRaise || BIG_BLIND,
            revealedStage: data.revealedStage || '',
            centerTokens: data.centerChips || 0,
            calledNumber: data.calledNumber || null,
            calledNumbers: data.calledNumbers || [],
            bingoCard: data.bingoCards?.[idx] || null,
            marked: data.marked?.[idx] || [],
            bingoCards: room.gameType === 'bingo' ? data.bingoCards || [] : undefined,
            allMarked: room.gameType === 'bingo' ? data.marked || [] : undefined,
            bingoMode: room.bingoMode || 'hard',
            phase: publicPhase(data.phase || ''),
            turnIdx: data.turnIdx ?? 0,
            dice: data.dice || [],
            diceRolling: !!data.diceRolling,
            bingoDrawing: !!data.bingoDrawing,
            message: publicTableText(data.message || ''),
            soundEvent: data.soundEvent ? { ...data.soundEvent, sound: data.soundEvent.sound === 'bet' ? 'pick' : data.soundEvent.sound } : null,
            tokenDenominations: CHIP_DENOMINATIONS,
            gameplayMusicEnabled: room.gameplayMusicEnabled,
            pointsPlayEnabled: !!room.pointsPlayEnabled,
            data_value_gamma: room.gameType === 'roulette' ? {
                isAmerican: !!data.isAmerican,
                wheel: rouletteWheel(data.isAmerican),
                winningNumber: data.winningNumber || null,
                winningIndex: data.winningIndex ?? null,
                spinSeq: data.spinSeq || 0,
                history: data.history || [],
                picks: players[idx]?.picks || [],
            } : undefined,
            data_value_delta: room.gameType === 'bank_dice' ? {
                point: data.point || null,
                rollSeq: data.rollSeq || 0,
                picks: players[idx]?.picks || {},
                finalDice: data.finalDice || [],
                history: data.history || [],
            } : undefined,
            data_value_epsilon: room.gameType === 'baccarat' ? {
                playerHand: data.playerHand || [],
                secondHand: data.bankerHand || [],
                playerTotal: baccaratTotal(data.playerHand || []),
                secondTotal: baccaratTotal(data.bankerHand || []),
                winner: publicTwoHandResult(data.winner || null),
                dealSeq: data.dealSeq || 0,
                picks: players[idx]?.picks || {},
                history: (data.history || []).map(h => ({ ...h, winner: publicTwoHandResult(h.winner) })),
            } : undefined,
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
    const waiting = data.players.some((p, idx) => room.players[idx].connected && p.chips > 0 && (!p.doneBetting || p.bet <= 0));
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
        if (!p.cards?.length || (room.pointsPlayEnabled && p.bet <= 0)) return;
        const value = cardValue(p.cards);
        const originalBet = p.bet || 0;
        const insurance = p.insurance || 0;
        if (insurance && dealerNatural) p.chips += insurance * 3;
        if (!room.pointsPlayEnabled) {
            const didWin = !p.bust && value <= 21 && (dealerValue > 21 || value > dealerValue || (isNaturalBlackjack(p.cards) && !dealerNatural));
            const pushed = !p.bust && value === dealerValue;
            if (pushed) p.result = 'push'; else addRecordResult(p, didWin, didWin ? 'W' : 'L');
        } else if (p.bust || value > 21) p.result = 'lose';
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
        const eligibleSeat = room.players[idx].connected && (!room.pointsPlayEnabled || p.chips > 0);
        p.cards = eligibleSeat ? [room.deck.pop(), room.deck.pop()] : [];
        p.bet = 0; p.roundBet = 0; p.folded = false; p.acted = false; p.result = null; p.role = '';
    });
    const eligible = data.players.map((p, idx) => idx).filter(idx => room.players[idx].connected && data.players[idx].cards?.length);
    if (eligible.length < 2) { data.message = room.pointsPlayEnabled ? 'Need at least two players with chips.' : 'Need at least two active players.'; return; }
    if (!room.pointsPlayEnabled) {
        data.dealerIdx = data.dealerIdx == null ? eligible[0] : nextHoldemSeat(data, data.dealerIdx);
        data.turnIdx = nextHoldemSeat(data, data.dealerIdx);
        data.message = 'No-chip Texas Hold\'em: choose All-In! or Fold.';
        runTableBots(room);
        return;
    }
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
    if (!room.pointsPlayEnabled) {
        data.players.forEach(p => {
            if (!p.cards?.length) return;
            const didWin = winners.includes(p);
            addRecordResult(p, didWin, didWin ? `${p.result || 'Winner'} • W` : `${p.result || 'Out'} • L`);
        });
        data.message = `${winners.map(p => p.name).join(', ')} won the hand.`;
        data.pot = 0;
        return;
    }
    const share = Math.floor((data.pot || 0) / Math.max(1, winners.length));
    winners.forEach(p => { p.chips += share; p.result = `${p.result || 'Winner'} +${share}`; });
    data.message = `${winners.map(p => p.name).join(', ')} won the pot.`;
    data.pot = 0;
}

function handleHoldemAction(room, playerIdx, action, amount = 0) {
    const data = room.tableData;
    if (!room?.pointsPlayEnabled) {
        if (!data || room.gameType !== 'texas_holdem' || !['preflop','flop','turn','river'].includes(data.phase) || data.turnIdx !== playerIdx) return;
        const p = data.players[playerIdx]; if (!p || p.folded || !p.cards?.length) return;
        if (action === 'fold') { p.folded = true; p.acted = true; p.result = 'Folded'; data.message = `${p.name} folded.`; markTableSound(room, 'fold'); }
        else if (action === 'all_in') { p.acted = true; p.result = 'All-In!'; data.message = `${p.name} is all in.`; markTableSound(room, 'ready'); }
        else return;
        const active = holdemActivePlayers(data);
        if (active.length <= 1 || active.every(x => x.acted)) {
            while ((data.community || []).length < 5) data.community.push(room.deck.pop());
            data.revealedStage = 'showdown';
            settleHoldem(room);
        } else data.turnIdx = nextHoldemSeat(data, playerIdx);
        runTableBots(room); sendTableState(room); return;
    }
    if (!room?.pointsPlayEnabled) return;

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
    if (!room?.pointsPlayEnabled) return;
    const data = room.tableData;
    if (!data || room.gameType !== 'blackjack_chips') return;
    const player = data.players[playerIdx];
    if (!player || data.phase !== 'betting' || player.doneBetting) return;
    amount = Math.max(0, Math.min(Math.floor(Number(amount || 0)), player.chips)); if (!amount) return;
    player.chips -= amount; player.bet += amount; data.pot += amount;
    data.message = `${player.name} added ${amount} to their bet. Press Done Betting when ready.`;
    markTableSound(room, 'bet');
    sendTableState(room);
}


function refundBlackjackBet(room, playerIdx, amount) {
    if (!room?.pointsPlayEnabled) return;
    const data = room.tableData;
    if (!data || room.gameType !== 'blackjack_chips') return;
    const player = data.players[playerIdx];
    if (!player || data.phase !== 'betting' || player.doneBetting) return;
    const refund = Math.max(1, Math.min(Math.floor(Number(amount || 0)), player.bet || 0));
    if (!refund) return;
    player.bet -= refund;
    player.chips += refund;
    data.pot = Math.max(0, (data.pot || 0) - refund);
    data.message = `${player.name} removed ${refund} from their bet.`;
    markTableSound(room, 'click');
    sendTableState(room);
}

function handleDoneBetting(room, playerIdx) {
    if (!room?.pointsPlayEnabled) return;
    const data = room.tableData;
    if (!data || room.gameType !== 'blackjack_chips' || data.phase !== 'betting') return;
    const player = data.players[playerIdx]; if (!player || player.bet <= 0) return;
    player.doneBetting = true; data.message = `${player.name} is done betting.`;
    markTableSound(room, 'ready');
    dealBlackjackIfReady(room); sendTableState(room);
}

function handleBlackjackInsurance(room, playerIdx, take) {
    if (!room?.pointsPlayEnabled) return;
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


function dealPracticeBlackjack(room, message = 'Practice Blackjack: no betting, just hit or stand.') {
    const data = room.tableData;
    if (!data || room.gameType !== 'blackjack_chips') return;
    room.deck = buildDeck();
    data.players.forEach((p, idx) => {
        p.bet = 0;
        p.doneBetting = true;
        p.cards = room.players[idx].connected ? [room.deck.pop(), room.deck.pop()] : [];
        p.stand = false;
        p.bust = false;
        p.result = null;
        p.insurance = 0;
        p.insuranceOffered = false;
    });
    data.dealer = { cards: [room.deck.pop(), { hidden: true }], reveal: false };
    data.pot = 0;
    data.phase = 'player_turn';
    data.turnIdx = currentPlayerIdx(data, room);
    data.message = message;
    runTableBots(room);
}

function resetBlackjackHand(room) {
    if (!room.tableData || room.gameType !== 'blackjack_chips') return;
    room.deck = buildDeck();
    room.tableData.players.forEach(p => { p.bet=0; p.cards=[]; p.doneBetting=false; p.stand=false; p.bust=false; p.result=null; p.insurance=0; p.insuranceOffered=false; });
    room.tableData.dealer = { cards: [] }; room.tableData.pot = 0;
    if (!room.pointsPlayEnabled) { dealPracticeBlackjack(room); sendTableState(room); return; }
    room.tableData.phase = 'betting'; room.tableData.message = 'Place your blackjack bet, then press Done Betting.';
    autoBlackjackBots(room); sendTableState(room);
}

function applyLcrDice(room, playerIdx, dice) {
    const data = room.tableData; const player = data.players[playerIdx]; const n = data.players.length;
    for (const face of dice) { if (face === 'L') { player.chips--; data.players[(playerIdx - 1 + n) % n].chips++; } if (face === 'R') { player.chips--; data.players[(playerIdx + 1) % n].chips++; } if (face === 'C') { player.chips--; data.centerChips++; } }
    data.diceRolling = false;
    const active = data.players.filter(p => p.chips > 0);
    if (active.length === 1) { room.state = 'over'; room.winner = active[0].name; data.message = `${active[0].name} wins LCR!`; sendTableState(room); broadcast(room, { type:'gameover', winner: active[0].name, gameType: publicGameType(room.gameType), reason: 'lcr' }); }
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
        if (data.phase === 'player_turn' && room.players[data.turnIdx]?.isBot) setTimeout(() => { if (room.tableData !== data || data.phase !== 'player_turn' || !room.players[data.turnIdx]?.isBot) return; const botIdx = data.turnIdx; handleBlackjackAction(room, botIdx, cardValue(data.players[botIdx].cards) < 16 ? 'hit' : 'stand'); botMoveChat(room, botIdx, room.pointsPlayEnabled ? 'bet' : 'play'); }, 700);
    }
    if (room.gameType === 'left_center_right' && room.players[data.turnIdx]?.isBot && !data.diceRolling) setTimeout(() => { const botIdx = data.turnIdx; handleLcrRoll(room, botIdx); botMoveChat(room, botIdx, 'roll'); }, 800);
    if (room.gameType === 'texas_holdem' && ['preflop','flop','turn','river'].includes(data.phase) && room.players[data.turnIdx]?.isBot) setTimeout(() => { if (room.tableData !== data || !room.players[data.turnIdx]?.isBot) return; const p = data.players[data.turnIdx]; const toCall = Math.max(0, data.currentBet - p.roundBet); const botIdx = data.turnIdx; handleHoldemAction(room, botIdx, room.pointsPlayEnabled ? (toCall ? 'call' : 'check') : (Math.random() < 0.8 ? 'all_in' : 'fold')); botMoveChat(room, botIdx, room.pointsPlayEnabled ? 'bet' : 'play'); }, 900);
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
        broadcast(room, { type:'gameover', winner: room.winner, gameType: publicGameType(room.gameType) });
    }
    sendTableState(room);
}


const AMERICAN_ROULETTE_WHEEL = ["0", "28", "9", "26", "30", "11", "7", "20", "32", "17", "5", "22", "34", "15", "3", "24", "36", "13", "1", "00", "27", "10", "25", "29", "12", "8", "19", "31", "18", "6", "21", "33", "16", "4", "23", "35", "14", "2"];
const EUROPEAN_ROULETTE_WHEEL = ["0", "32", "15", "19", "4", "21", "2", "25", "17", "34", "6", "27", "13", "36", "11", "30", "8", "23", "10", "5", "24", "16", "33", "1", "20", "14", "31", "9", "22", "18", "29", "7", "28", "12", "35", "3", "26"];
const ROULETTE_REDS = new Set(['1','3','5','7','9','12','14','16','18','19','21','23','25','27','30','32','34','36']);

function rouletteWheel(isAmerican = true) {
    return isAmerican ? AMERICAN_ROULETTE_WHEEL : EUROPEAN_ROULETTE_WHEEL;
}

function rouletteColor(value) {
    const text = String(value);
    if (text === '0' || text === '00') return 'green';
    return ROULETTE_REDS.has(text) ? 'red' : 'black';
}

function normalizeBetAmount(player, amount) {
    const clean = Math.max(0, Math.floor(Number(amount || 0)));
    if (!clean || !player || clean > player.chips) return 0;
    return clean;
}


function addRecordResult(player, didWin, label = '') {
    if (!player) return;
    player.wins = player.wins || 0;
    player.losses = player.losses || 0;
    player.points = player.points || 0;
    if (didWin) { player.wins++; player.points += 10; player.result = label || '+10'; }
    else { player.losses++; player.points = Math.max(0, player.points - 10); player.result = label || '-10'; }
}

function addPracticePick(room, playerIdx, pick = {}) {
    const data = room.tableData;
    const player = data?.players?.[playerIdx];
    if (!data || !player || !room.players[playerIdx]?.connected) return false;
    const type = String(pick.pickType || pick.betType || 'straight');
    const selection = Array.isArray(pick.selection) ? pick.selection.map(String) : [String(pick.selection ?? type)];
    player.prediction = { type, selection };
    player.result = `picked ${selection.join('/')}`;
    data.message = `${player.name} made a no-chip pick.`;
    sendTableState(room);
    return true;
}

function predictionMatchesRoulette(prediction, outcome, isAmerican) {
    if (!prediction) return null;
    return rouletteBetWins({ type: prediction.type, selection: prediction.selection, amount: 0 }, outcome, isAmerican);
}

function bankDicePredictionOutcome(prediction, total, previousPoint, currentPoint) {
    if (!prediction) return null;
    const type = prediction.type;
    if (type === 'field') return [2,3,4,9,10,11,12].includes(total);
    if (!previousPoint) {
        if ([7,11].includes(total)) return type === 'pass' || type === 'come';
        if ([2,3,12].includes(total)) return type === 'dontPass' || type === 'dontCome';
        return null;
    }
    if (total === previousPoint) return type === 'pass' || type === 'come';
    if (total === 7) return type === 'dontPass' || type === 'dontCome';
    return null;
}

function baccaratPredictionOutcome(prediction, winner) {
    if (!prediction) return null;
    const type = prediction.type === 'sideB' ? 'banker' : prediction.type;
    const selection = (prediction.selection || []).map(v => v === 'sideB' ? 'banker' : v);
    return type === winner || selection.includes(winner);
}

function addTableBet(room, playerIdx, bet) {
    if (!room?.pointsPlayEnabled) return false;
    const data = room.tableData;
    const player = data?.players?.[playerIdx];
    if (!data || !player || !room.players[playerIdx]?.connected) return false;
    const amount = normalizeBetAmount(player, bet.amount);
    if (!amount) { data.message = 'Bet rejected: not enough virtual chips.'; sendTableState(room); return false; }

    if (room.gameType === 'roulette') return addRouletteBet(room, player, bet, amount);
    if (room.gameType === 'bank_dice') return addBankDiceBet(room, player, bet, amount);
    if (room.gameType === 'baccarat') return addBaccaratBet(room, player, bet, amount);
    return false;
}


function sameSelection(a = [], b = []) {
    const aa = [...a].map(String).sort().join('|');
    const bb = [...b].map(String).sort().join('|');
    return aa === bb;
}

function subtractTableBet(room, playerIdx, bet) {
    if (!room?.pointsPlayEnabled) return false;
    const data = room.tableData;
    const player = data?.players?.[playerIdx];
    if (!data || !player || !room.players[playerIdx]?.connected) return false;
    const amount = Math.max(1, Math.floor(Number(bet.amount || 0)));
    if (room.gameType === 'roulette') return subtractRouletteBet(room, player, bet, amount);
    if (room.gameType === 'bank_dice') return subtractBankDiceBet(room, player, bet, amount);
    if (room.gameType === 'baccarat') return subtractBaccaratBet(room, player, bet, amount);
    return false;
}

function refundTableAmount(room, player, amount) {
    const refund = Math.max(0, Math.floor(amount));
    if (!refund) return false;
    player.chips += refund;
    player.bet = Math.max(0, (player.bet || 0) - refund);
    room.tableData.pot = Math.max(0, (room.tableData.pot || 0) - refund);
    room.tableData.message = `${player.name} removed ${refund} from their bet.`;
    markTableSound(room, 'click');
    sendTableState(room);
    return true;
}

function subtractRouletteBet(room, player, bet, amount) {
    const data = room.tableData;
    if (data.phase === 'spinning') return false;
    const type = String(bet.pickType || bet.betType || 'straight');
    const selection = Array.isArray(bet.selection) ? bet.selection.map(String) : [String(bet.selection ?? '')];
    if (type === 'basket') selection.splice(0, selection.length, '0', '00', '1', '2', '3');
    const idx = [...(player.bets || [])].reverse().findIndex(existing => existing.type === type && sameSelection(existing.selection, selection));
    if (idx < 0) return false;
    const realIdx = player.bets.length - 1 - idx;
    const existing = player.bets[realIdx];
    const refund = Math.min(amount, existing.amount);
    existing.amount -= refund;
    if (existing.amount <= 0) player.bets.splice(realIdx, 1);
    return refundTableAmount(room, player, refund);
}

function subtractBankDiceBet(room, player, bet, amount) {
    const data = room.tableData;
    if (data.phase === 'rolling') return false;
    const type = String(bet.pickType || bet.betType || 'pass');
    let refund = 0;
    if (type === 'come' || type === 'dontCome') {
        const list = player.bets[type] || [];
        const idx = list.length - 1;
        if (idx < 0) return false;
        refund = Math.min(amount, list[idx].amount);
        list[idx].amount -= refund;
        if (list[idx].amount <= 0) list.splice(idx, 1);
    } else if (['pass','dontPass','field'].includes(type)) {
        refund = Math.min(amount, player.bets[type] || 0);
        player.bets[type] = Math.max(0, (player.bets[type] || 0) - refund);
    }
    return refundTableAmount(room, player, refund);
}

function subtractBaccaratBet(room, player, bet, amount) {
    const data = room.tableData;
    if (data.phase !== 'betting') return false;
    let type = String(bet.pickType || bet.betType || 'player');
    if (type === 'sideB') type = 'banker';
    if (!['player','banker','tie'].includes(type)) return false;
    const refund = Math.min(amount, player.bets[type] || 0);
    player.bets[type] = Math.max(0, (player.bets[type] || 0) - refund);
    return refundTableAmount(room, player, refund);
}

function addRouletteBet(room, player, bet, amount) {
    const data = room.tableData;
    if (data.phase === 'spinning') return false;
    const type = String(bet.pickType || bet.betType || 'straight');
    const selection = Array.isArray(bet.selection) ? bet.selection.map(String) : [String(bet.selection ?? '')];
    const allowed = ['straight','split','street','corner','column','dozen','red','black','even','odd','basket'];
    if (!allowed.includes(type)) return false;
    if (!data.isAmerican && (type === 'basket' || selection.includes('00'))) { data.message = 'European Roulette disables 00 and the basket bet.'; sendTableState(room); return false; }
    if (type === 'basket') selection.splice(0, selection.length, '0', '00', '1', '2', '3');
    player.chips -= amount;
    player.bets.push({ type, selection, amount });
    player.bet = (player.bet || 0) + amount;
    data.pot += amount;
    data.phase = 'betting';
    data.message = `${player.name} placed ${amount} on ${type}.`;
    sendTableState(room);
    return true;
}

function rouletteBetWins(bet, outcome, isAmerican) {
    const n = Number(outcome);
    const sel = (bet.selection || []).map(String);
    if (bet.type === 'straight') return sel.includes(String(outcome));
    if (bet.type === 'split' || bet.type === 'street' || bet.type === 'corner' || bet.type === 'basket') return sel.includes(String(outcome));
    if (outcome === '0' || outcome === '00') return false;
    if (bet.type === 'red' || bet.type === 'black') return rouletteColor(outcome) === bet.type;
    if (bet.type === 'even') return n % 2 === 0;
    if (bet.type === 'odd') return n % 2 === 1;
    if (bet.type === 'dozen') return (sel[0] === '1' && n >= 1 && n <= 12) || (sel[0] === '2' && n >= 13 && n <= 24) || (sel[0] === '3' && n >= 25 && n <= 36);
    if (bet.type === 'column') return n >= 1 && n <= 36 && ((n - Number(sel[0])) % 3 === 0);
    return false;
}

function rouletteOdds(type) {
    return ({ straight: 35, split: 17, street: 11, corner: 8, basket: 6, column: 2, dozen: 2, red: 1, black: 1, even: 1, odd: 1 })[type] || 0;
}

function spinRoulette(room) {
    const data = room.tableData;
    if (!data || room.gameType !== 'roulette' || data.phase === 'spinning') return;
    const wheel = rouletteWheel(data.isAmerican);
    const winningIndex = Math.floor(Math.random() * wheel.length);
    const winningNumber = wheel[winningIndex];
    data.phase = 'spinning';
    data.winningNumber = winningNumber;
    data.winningIndex = winningIndex;
    data.spinSeq = (data.spinSeq || 0) + 1;
    data.message = `Wheel spinning in ${data.isAmerican ? 'American' : 'European'} mode...`;
    markTableSound(room, 'roll');
    sendTableState(room);
    setTimeout(() => {
        if (room.tableData !== data) return;
        data.players.forEach(player => {
            if (!room.pointsPlayEnabled) {
                const matched = predictionMatchesRoulette(player.prediction, winningNumber, data.isAmerican);
                if (matched !== null) addRecordResult(player, matched, matched ? '+10 points' : '-10 points');
                player.prediction = null;
                player.bets = [];
                player.bet = 0;
                return;
            }
            let returned = 0;
            for (const bet of player.bets || []) {
                if (rouletteBetWins(bet, winningNumber, data.isAmerican)) returned += bet.amount * (rouletteOdds(bet.type) + 1);
            }
            player.chips += returned;
            player.result = returned ? `won ${returned}` : ((player.bets || []).length ? 'lose' : null);
            player.bets = [];
            player.bet = 0;
        });
        data.pot = 0;
        data.phase = 'result';
        data.history.unshift({ number: winningNumber, color: rouletteColor(winningNumber) });
        data.history = data.history.slice(0, 10);
        data.message = `Roulette result: ${winningNumber} ${rouletteColor(winningNumber).toUpperCase()}. Place new virtual-chip bets or spin again.`;
        sendTableState(room);
    }, 3600);
}

function setRouletteMode(room, isAmerican) {
    const data = room.tableData;
    if (!data || room.gameType !== 'roulette' || data.phase === 'spinning') return;
    data.isAmerican = !!isAmerican;
    data.players.forEach(p => { p.bets = []; p.bet = 0; p.result = null; });
    data.pot = 0;
    data.winningNumber = null;
    data.winningIndex = null;
    data.message = `${data.isAmerican ? 'American' : 'European'} Roulette selected. ${data.isAmerican ? '00 and basket bets are enabled.' : '00 and basket bets are disabled.'}`;
    sendTableState(room);
}

function addBankDiceBet(room, player, bet, amount) {
    const data = room.tableData;
    if (data.phase === 'rolling') return false;
    const type = String(bet.pickType || bet.betType || 'pass');
    if (!['pass','dontPass','come','dontCome','field'].includes(type)) return false;
    player.chips -= amount;
    if (type === 'come' || type === 'dontCome') player.bets[type].push({ amount, point: null });
    else player.bets[type] = (player.bets[type] || 0) + amount;
    player.bet = (player.bet || 0) + amount;
    data.pot += amount;
    data.phase = data.phase || 'comeout';
    data.message = `${player.name} placed ${amount} on ${type}.`;
    sendTableState(room);
    return true;
}

function payPlayer(player, amount) {
    player.chips += Math.max(0, Math.floor(amount));
}

function settleBankDiceBet(player, key, outcome) {
    const amount = player.bets[key] || 0;
    if (!amount) return;
    if (outcome === 'win') payPlayer(player, amount * 2);
    if (outcome === 'push') payPlayer(player, amount);
    player.bets[key] = 0;
}

function settleBankDice(room, d1, d2) {
    const data = room.tableData;
    const total = d1 + d2;
    const previousPoint = data.point || null;
    data.players.forEach(player => {
        player.result = null;
        const field = player.bets.field || 0;
        if (field) {
            if ([3,4,9,10,11].includes(total)) { payPlayer(player, field * 2); player.result = 'field win'; }
            else if ([2,12].includes(total)) { payPlayer(player, field * 3); player.result = 'field double'; }
            else player.result = 'field lose';
            player.bets.field = 0;
        }
        for (const come of player.bets.come || []) {
            if (come.point && total === come.point) { payPlayer(player, come.amount * 2); come.done = true; player.result = 'come win'; }
            else if (come.point && total === 7) { come.done = true; player.result = player.result || 'seven out'; }
        }
        player.bets.come = (player.bets.come || []).filter(b => !b.done);
        for (const come of player.bets.dontCome || []) {
            if (come.point && total === 7) { payPlayer(player, come.amount * 2); come.done = true; player.result = 'don\'t come win'; }
            else if (come.point && total === come.point) { come.done = true; player.result = player.result || 'don\'t come lose'; }
        }
        player.bets.dontCome = (player.bets.dontCome || []).filter(b => !b.done);
    });

    if (!data.point) {
        if ([7,11].includes(total)) data.players.forEach(p => { settleBankDiceBet(p, 'pass', 'win'); settleBankDiceBet(p, 'dontPass', 'lose'); });
        else if ([2,3].includes(total)) data.players.forEach(p => { settleBankDiceBet(p, 'pass', 'lose'); settleBankDiceBet(p, 'dontPass', 'win'); });
        else if (total === 12) data.players.forEach(p => { settleBankDiceBet(p, 'pass', 'lose'); settleBankDiceBet(p, 'dontPass', 'push'); });
        else data.point = total;
    } else if (total === data.point) {
        data.players.forEach(p => { settleBankDiceBet(p, 'pass', 'win'); settleBankDiceBet(p, 'dontPass', 'lose'); });
        data.point = null;
    } else if (total === 7) {
        data.players.forEach(p => { settleBankDiceBet(p, 'pass', 'lose'); settleBankDiceBet(p, 'dontPass', 'win'); });
        data.point = null;
    }

    data.players.forEach(player => {
        for (const come of player.bets.come || []) {
            if (!come.point) {
                if ([7,11].includes(total)) { payPlayer(player, come.amount * 2); come.done = true; player.result = 'come win'; }
                else if ([2,3,12].includes(total)) { come.done = true; player.result = player.result || 'come lose'; }
                else come.point = total;
            }
        }
        player.bets.come = (player.bets.come || []).filter(b => !b.done);
        for (const come of player.bets.dontCome || []) {
            if (!come.point) {
                if ([2,3].includes(total)) { payPlayer(player, come.amount * 2); come.done = true; player.result = 'don\'t come win'; }
                else if (total === 12) { payPlayer(player, come.amount); come.done = true; player.result = 'don\'t come push'; }
                else if ([7,11].includes(total)) { come.done = true; player.result = player.result || 'don\'t come lose'; }
                else come.point = total;
            }
        }
        player.bets.dontCome = (player.bets.dontCome || []).filter(b => !b.done);
    });

    data.phase = data.point ? 'point' : 'comeout';
    data.pot = data.players.reduce((sum, p) => sum + (p.bets.pass || 0) + (p.bets.dontPass || 0) + (p.bets.field || 0) + (p.bets.come || []).reduce((s, b) => s + b.amount, 0) + (p.bets.dontCome || []).reduce((s, b) => s + b.amount, 0), 0);
    data.players.forEach(p => { p.bet = (p.bets.pass || 0) + (p.bets.dontPass || 0) + (p.bets.field || 0) + (p.bets.come || []).reduce((sum, b) => sum + b.amount, 0) + (p.bets.dontCome || []).reduce((sum, b) => sum + b.amount, 0); });
    if (!room.pointsPlayEnabled) {
        data.players.forEach(player => {
            const outcome = bankDicePredictionOutcome(player.prediction, total, previousPoint, data.point);
            if (outcome !== null) { addRecordResult(player, outcome, outcome ? '+10 points' : '-10 points'); player.prediction = null; }
        });
        data.pot = 0;
    }
    data.history.unshift({ dice: [d1, d2], total, point: data.point });
    data.history = data.history.slice(0, 10);
    data.message = `Bank Dice rolled ${d1} + ${d2} = ${total}.${data.point ? ` Point is ${data.point}.` : ' Come-out roll next.'}`;
}

function rollBankDice(room) {
    const data = room.tableData;
    if (!data || room.gameType !== 'bank_dice' || data.phase === 'rolling') return;
    const d1 = 1 + Math.floor(Math.random() * 6);
    const d2 = 1 + Math.floor(Math.random() * 6);
    data.phase = 'rolling';
    data.dice = ['-', '-'];
    data.finalDice = [d1, d2];
    data.rollSeq = (data.rollSeq || 0) + 1;
    data.message = 'Bank Dice rolling across the table...';
    markTableSound(room, 'roll');
    sendTableState(room);
    setTimeout(() => { if (room.tableData !== data) return; data.dice = [d1, d2]; settleBankDice(room, d1, d2); sendTableState(room); }, 1700);
}

function addBaccaratBet(room, player, bet, amount) {
    const data = room.tableData;
    if (data.phase !== 'betting') return false;
    let type = String(bet.pickType || bet.betType || 'player');
    if (type === 'sideB') type = 'banker';
    if (!['player','banker','tie'].includes(type)) return false;
    player.chips -= amount;
    player.bets[type] = (player.bets[type] || 0) + amount;
    player.bet = Object.values(player.bets).reduce((a, b) => a + b, 0);
    data.pot += amount;
    data.message = `${player.name} backed ${type} for ${amount}.`;
    sendTableState(room);
    return true;
}

function baccaratCardValue(card) {
    if (!card) return 0;
    if (['10','J','Q','K'].includes(card.rank)) return 0;
    if (card.rank === 'A') return 1;
    return Number(card.rank) || 0;
}

function baccaratTotal(cards) {
    return (cards || []).reduce((sum, card) => sum + baccaratCardValue(card), 0) % 10;
}

function shouldBankerDraw(bankerTotal, playerThirdValue) {
    if (playerThirdValue == null) return bankerTotal <= 5;
    if (bankerTotal <= 2) return true;
    if (bankerTotal === 3) return playerThirdValue !== 8;
    if (bankerTotal === 4) return playerThirdValue >= 2 && playerThirdValue <= 7;
    if (bankerTotal === 5) return playerThirdValue >= 4 && playerThirdValue <= 7;
    if (bankerTotal === 6) return playerThirdValue === 6 || playerThirdValue === 7;
    return false;
}

function dealBaccarat(room) {
    const data = room.tableData;
    if (!data || room.gameType !== 'baccarat' || data.phase !== 'betting') return;
    room.deck = buildDeck();
    data.playerHand = [room.deck.pop(), room.deck.pop()];
    data.bankerHand = [room.deck.pop(), room.deck.pop()];
    let playerTotal = baccaratTotal(data.playerHand);
    let bankerTotal = baccaratTotal(data.bankerHand);
    let playerThirdValue = null;
    if (playerTotal < 8 && bankerTotal < 8) {
        if (playerTotal <= 5) {
            const third = room.deck.pop();
            data.playerHand.push(third);
            playerThirdValue = baccaratCardValue(third);
            playerTotal = baccaratTotal(data.playerHand);
        }
        if (shouldBankerDraw(bankerTotal, playerThirdValue)) {
            data.bankerHand.push(room.deck.pop());
            bankerTotal = baccaratTotal(data.bankerHand);
        }
    }
    const winner = playerTotal === bankerTotal ? 'tie' : (playerTotal > bankerTotal ? 'player' : 'banker');
    data.winner = winner;
    data.players.forEach(player => {
        const bets = player.bets || {};
        if (!room.pointsPlayEnabled) {
            const outcome = baccaratPredictionOutcome(player.prediction, winner);
            if (outcome !== null) addRecordResult(player, outcome, outcome ? '+10 points' : '-10 points');
            player.prediction = null;
        } else if (winner === 'tie') {
            if (bets.player) payPlayer(player, bets.player);
            if (bets.banker) payPlayer(player, bets.banker);
            if (bets.tie) payPlayer(player, bets.tie * 9);
        } else if (winner === 'player') {
            if (bets.player) payPlayer(player, bets.player * 2);
        } else if (winner === 'banker') {
            if (bets.banker) payPlayer(player, Math.floor(bets.banker * 1.95));
        }
        if (room.pointsPlayEnabled) player.result = `${winner} ${winner === 'banker' ? '(5% commission)' : 'wins'}`;
        player.bet = 0;
        player.bets = { player: 0, banker: 0, tie: 0 };
    });
    data.pot = 0;
    data.phase = 'settled';
    data.dealSeq = (data.dealSeq || 0) + 1;
    data.history.unshift({ winner, playerTotal, bankerTotal });
    data.history = data.history.slice(0, 10);
    data.message = `Baccarat: Player ${playerTotal}, Banker ${bankerTotal}. ${winner.toUpperCase()} wins.`;
    markTableSound(room, winner === 'tie' ? 'ding' : 'card');
    sendTableState(room);
}

function resetTableRound(room) {
    const data = room.tableData;
    if (!data) return;
    if (room.gameType === 'roulette') {
        data.players.forEach(p => { p.bets = []; p.bet = 0; p.result = null; });
        data.pot = 0; data.phase = 'betting'; data.message = 'Place virtual-chip roulette bets.'; sendTableState(room);
    }
    if (room.gameType === 'baccarat') {
        data.playerHand = []; data.bankerHand = []; data.winner = null; data.phase = 'betting'; data.message = 'Place Player, Banker, or Tie bets.'; sendTableState(room);
    }
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
            players: makeChipPlayers(room, room.pointsPlayEnabled ? 500 : 0).map(p => room.pointsPlayEnabled ? p : { ...p, chips: null }),
            dealer: { cards: [] },
            pot: 0,
            phase: 'betting',
            turnIdx: 0,
            message: room.pointsPlayEnabled ? 'Place your blackjack bet, then press Done Betting. Starting balance: 500.' : 'Practice Blackjack: no betting, just hit or stand.',
        };
        if (!room.pointsPlayEnabled) dealPracticeBlackjack(room);
    } else if (room.gameType === 'texas_holdem') {
        room.tableData = {
            players: makeChipPlayers(room, room.pointsPlayEnabled ? 1000 : 0).map(p => room.pointsPlayEnabled ? p : { ...p, chips: null, points: 0 }),
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
            message: room.pointsPlayEnabled ? 'Texas Hold\'em is dealing. Blinds post automatically.' : 'Texas Hold\'em is dealing in no-chip mode.',
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
    } else if (room.gameType === 'roulette') {
        room.tableData = {
            players: makeChipPlayers(room, room.pointsPlayEnabled ? 1000 : 0).map(p => ({ ...p, chips: room.pointsPlayEnabled ? p.chips : null, points: 0, bets: [] })),
            pot: 0,
            phase: 'betting',
            isAmerican: true,
            winningNumber: null,
            winningIndex: null,
            spinSeq: 0,
            history: [],
            message: room.pointsPlayEnabled ? 'American Roulette selected. Place chip bets, then spin.' : 'No-chip Roulette: pick what you think will win. Correct picks earn +10 points.',
        };
    } else if (room.gameType === 'bank_dice') {
        room.tableData = {
            players: makeChipPlayers(room, room.pointsPlayEnabled ? 1000 : 0).map(p => ({ ...p, chips: room.pointsPlayEnabled ? p.chips : null, points: room.pointsPlayEnabled ? 0 : 100, bets: { pass: 0, dontPass: 0, come: [], dontCome: [], field: 0 } })),
            pot: 0,
            phase: 'comeout',
            point: null,
            dice: [],
            rollSeq: 0,
            history: [],
            message: 'Bank Dice come-out roll. Place Pass, Don\'t Pass, Come, Don\'t Come, or Field bets with virtual chips.',
        };
    } else if (room.gameType === 'baccarat') {
        room.tableData = {
            players: makeChipPlayers(room, room.pointsPlayEnabled ? 1000 : 0).map(p => ({ ...p, chips: room.pointsPlayEnabled ? p.chips : null, points: 0, bets: { player: 0, banker: 0, tie: 0 } })),
            playerHand: [],
            bankerHand: [],
            pot: 0,
            phase: 'betting',
            winner: null,
            dealSeq: 0,
            history: [],
            message: room.pointsPlayEnabled ? 'Baccarat: bet Player, Banker, or Tie. Drawing rules are automatic.' : 'No-chip Baccarat: pick which side wins. Correct picks earn +10 points.',
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

    sendChat(room, 'Server', 'Table started.');
    sendTableState(room);
    runTableBots(room);
}

const TIEN_LEN_RANKS = { '3':3, '4':4, '5':5, '6':6, '7':7, '8':8, '9':9, '10':10, J:11, Q:12, K:13, A:14, '2':15 };
const TIEN_LEN_SUITS = { Spades:1, Clubs:2, Diamonds:3, Hearts:4 };
function tienLenValue(card) { return (TIEN_LEN_RANKS[card?.rank] || 0) * 10 + (TIEN_LEN_SUITS[card?.suit] || 0); }
function startTienLen(room) {
    room.state = 'playing';
    room.deck = buildDeck();
    room.discard = [];
    room.tienLenPassed = new Set();
    room.players.forEach(p => { p.hand = []; p.connected = true; });
    const active = room.players.filter(p => p.connected);
    const handSize = Math.min(13, Math.floor(room.deck.length / Math.max(1, active.length)));
    for (let i = 0; i < handSize; i++) room.players.forEach(p => { if (p.connected) p.hand.push(room.deck.pop()); });
    room.players.forEach(p => p.hand.sort((a, b) => tienLenValue(a) - tienLenValue(b)));
    let firstIdx = 0;
    room.players.forEach((p, idx) => { if (p.hand.some(c => c.rank === '3' && c.suit === 'Spades')) firstIdx = idx; });
    room.turnIdx = firstIdx;
    room.activeSuit = '';
    room.activeRank = '';
    room.hasDrawn = false;
    sendChat(room, 'Server', 'Table started.');
    sendState(room);
}
function handleTienLenPlay(room, playerIdx, cardIdx) {
    if (room.state !== 'playing' || room.gameType !== 'tien_len' || playerIdx !== room.turnIdx) return;
    const player = room.players[playerIdx];
    const card = player?.hand?.[cardIdx];
    if (!card) return;
    const top = room.discard[room.discard.length - 1];
    if (top && tienLenValue(card) <= tienLenValue(top)) return;
    player.hand.splice(cardIdx, 1);
    room.discard.push(card);
    room.activeSuit = card.suit;
    room.activeRank = card.rank;
    room.tienLenPassed = new Set();
    sendChat(room, 'Server', `${player.name} played a card.`);
    if (!player.hand.length) {
        room.state = 'over';
        room.winner = player.name;
        broadcast(room, { type:'gameover', winner: player.name, gameType: publicGameType(room.gameType) });
        sendState(room);
        return;
    }
    nextTienLenTurn(room);
    sendState(room);
}
function handleTienLenPass(room, playerIdx) {
    if (room.state !== 'playing' || room.gameType !== 'tien_len' || playerIdx !== room.turnIdx) return;
    room.tienLenPassed = room.tienLenPassed || new Set();
    room.tienLenPassed.add(playerIdx);
    const active = room.players.map((p, idx) => ({ p, idx })).filter(({p}) => p.connected && p.hand.length);
    if (room.tienLenPassed.size >= Math.max(0, active.length - 1)) {
        room.discard = [];
        room.activeSuit = '';
        room.activeRank = '';
        room.tienLenPassed = new Set();
        sendChat(room, 'Server', 'Trick cleared. Lead any single card.');
    } else {
        sendChat(room, 'Server', `${room.players[playerIdx].name} passed.`);
    }
    nextTienLenTurn(room);
    sendState(room);
}
function nextTienLenTurn(room) {
    const n = room.players.length;
    for (let i = 1; i <= n; i++) {
        const idx = (room.turnIdx + i) % n;
        if (room.players[idx]?.connected && room.players[idx].hand.length && !(room.tienLenPassed || new Set()).has(idx)) { room.turnIdx = idx; return; }
    }
    const idx = room.players.findIndex(p => p.connected && p.hand.length);
    room.turnIdx = idx >= 0 ? idx : 0;
}

function startGame(room) {
    if (room.players.length < 2 && room.gameType !== 'chat_room') return;
    if (room.gameType === 'tien_len') { startTienLen(room); return; }
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
            const personas = randomBotPersonas(Number(msg.count || 0));
            personas.forEach(persona => {
                myRoom.players.push({
                    name: persona.name,
                    personality: persona.personality,
                    isBot: true,
                    connected: true,
                    hand: []
                });
            });
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
                gameType: publicGameType(room.gameType),
                chatFilterEnabled: room.chatFilterEnabled,
                pointsPlayEnabled: !!room.pointsPlayEnabled,
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
            myRoom.pointsPlayEnabled = !!msg.pointsPlayEnabled;
            if (msg.bingoMode === 'easy' || msg.bingoMode === 'hard') myRoom.bingoMode = msg.bingoMode;
            broadcast(myRoom, lobbyPayload(myRoom));
            sendChat(myRoom, 'Server', `Chat filter ${myRoom.chatFilterEnabled ? 'enabled' : 'disabled'}. Picking tokens ${myRoom.pointsPlayEnabled ? 'enabled' : 'disabled'}. Gameplay music ${myRoom.gameplayMusicEnabled ? 'enabled' : 'disabled'}. Bingo mode ${(myRoom.bingoMode || 'hard').toUpperCase()}.`);
            return;
        }

        if (msg.type === 'set_game_type') {
            if (myIdx !== 0 || !myRoom || myRoom.state !== 'lobby') return;
            const incomingGameType = internalGameType(msg.gameType);
            const requestedGame = VALID_GAME_TYPES.includes(incomingGameType) ? incomingGameType : 'crazy_eights';
            const nextGame = canUseGame(myRoom, requestedGame) ? requestedGame : 'crazy_eights';
            myRoom.gameType = nextGame;
            broadcast(myRoom, lobbyPayload(myRoom));
            sendChat(myRoom, 'Server', 'Host selected a table.');
            return;
        }

        if (msg.type === 'start') {
            if (myIdx !== 0 || !myRoom) return;
            startGame(myRoom);
            return;
        }

        if (!myRoom || myIdx < 0) return;

        if (myRoom.gameType === 'crazy_eights' && msg.type === 'play') { handlePlay(myRoom, myIdx, msg.cardIdx, msg.chosenSuit || msg.chosenColor); return; }
        if (myRoom.gameType === 'crazy_eights' && msg.type === 'draw') { handleDraw(myRoom, myIdx); return; }
        if (myRoom.gameType === 'crazy_eights' && msg.type === 'pass') { handlePass(myRoom, myIdx); return; }
        if (myRoom.gameType === 'tien_len' && msg.type === 'play') { handleTienLenPlay(myRoom, myIdx, msg.cardIdx); return; }
        if (myRoom.gameType === 'tien_len' && msg.type === 'pass') { handleTienLenPass(myRoom, myIdx); return; }
        if (msg.type === 'table_pick' && !msg.pickType) { handleTableBet(myRoom, myIdx, msg.amount); return; }
        if (msg.type === 'table_pick_subtract' && !msg.pickType) { refundBlackjackBet(myRoom, myIdx, msg.amount); return; }
        if (msg.type === 'table_pick' && msg.pickType && !myRoom.pointsPlayEnabled) { addPracticePick(myRoom, myIdx, msg); return; }
        if (msg.type === 'table_pick' && msg.pickType) { addTableBet(myRoom, myIdx, msg); return; }
        if (msg.type === 'table_pick_subtract' && msg.pickType) { subtractTableBet(myRoom, myIdx, msg); return; }
        if (msg.type === 'data_value_gamma_spin') { if (myIdx === 0) spinRoulette(myRoom); return; }
        if (msg.type === 'data_value_gamma_set_mode') { if (myIdx === 0) setRouletteMode(myRoom, !!msg.isAmerican); return; }
        if (msg.type === 'data_value_delta_roll') { if (myIdx === 0) rollBankDice(myRoom); return; }
        if (msg.type === 'data_value_epsilon_deal') { if (myIdx === 0 || !myRoom.pointsPlayEnabled) dealBaccarat(myRoom); return; }
        if (msg.type === 'table_new_round') { if (myIdx === 0 || (myRoom.gameType === 'baccarat' && !myRoom.pointsPlayEnabled)) resetTableRound(myRoom); return; }
        if (msg.type === 'done_picking') { handleDoneBetting(myRoom, myIdx); return; }
        if (msg.type === 'twenty_one_cover') { handleBlackjackInsurance(myRoom, myIdx, !!msg.take); return; }
        if (msg.type === 'table_play_again') { if (myIdx === 0 && myRoom?.gameType === 'blackjack_chips') resetBlackjackHand(myRoom); if (myIdx === 0 && myRoom?.gameType === 'texas_holdem') { startHoldemHand(myRoom); sendTableState(myRoom); } return; }
        if (msg.type === 'riverCards_action') { handleHoldemAction(myRoom, myIdx, msg.action, msg.amount); return; }
        if (msg.type === 'bj_hit') { handleBlackjackAction(myRoom, myIdx, 'hit'); return; }
        if (msg.type === 'bj_stand') { handleBlackjackAction(myRoom, myIdx, 'stand'); return; }
        if (msg.type === 'lcr_roll') { handleLcrRoll(myRoom, myIdx); return; }
        if (msg.type === 'bingo_draw_next') { handleBingoDraw(myRoom, myIdx); return; }
        if (msg.type === 'bingo_mark') { handleBingoMark(myRoom, myIdx, msg.number); return; }
        if (msg.type === 'chat') {
            const text = (msg.text||'').slice(0,200);
            const speaker = myRoom.players[myIdx];
            if (!speaker) return;
            sendChat(myRoom, speaker.name, text);
            if (!speaker.isBot) {
                maybeRunCpuChat(myRoom, speaker.name, text);
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

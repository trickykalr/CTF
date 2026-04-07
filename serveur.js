// ═══════════════════════════════════════════════════════════
//  serveur.js — Node.js + Socket.io
// ═══════════════════════════════════════════════════════════

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');
const {
  buildDeck, drawCard, handTotal,
  isBust, isBlackjack, isSoft17, canSplit, computeResults,
} = require('./gameLogic');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'joueur')));

const rooms = {};

// ── Stratégies bots ───────────────────────────────────────────
const BOT_STRATEGIES = {
  conservative: { label:'Prudent 🛡️',    hitUntil:15, betAmounts:[5,10,25],     doubleOn:[] },
  balanced:     { label:'Équilibré ⚖️',   hitUntil:17, betAmounts:[10,25,50],    doubleOn:[10,11] },
  aggressive:   { label:'Agressif 🔥',    hitUntil:18, betAmounts:[50,75,100],   doubleOn:[9,10,11] },
  maniac:       { label:'Fou Furieux 🤪', hitUntil:19, betAmounts:[100,150,200], doubleOn:[8,9,10,11] },
};
function randomStrategy() {
  const k = Object.keys(BOT_STRATEGIES);
  return k[Math.floor(Math.random() * k.length)];
}

function cardValue(rank) {
  if (['J','Q','K'].includes(rank)) return 10;
  if (rank === 'A') return 11;
  return parseInt(rank, 10);
}

// ── Factories ─────────────────────────────────────────────────
function makePlayer(socketId, name, role) {
  return {
    socketId, name, role, strategy: null, isBot: false,
    balance: 1000, bet: 0, hand: [],
    stood: false, busted: false, doubled: false,
    hasSplit: false, playingSplit: false,
    splitHand: [], splitBet: 0, splitStood: false, splitBusted: false,
    result: null, gain: null, mainResult: null, splitResult: null,
  };
}

function makeBot(name, role = 'player') {
  const strategy = role === 'player' ? randomStrategy() : 'balanced';
  const strat    = BOT_STRATEGIES[strategy];
  return {
    socketId: 'bot_' + Math.random().toString(36).substring(2, 8),
    name: `${name} (${strat?.label||''})`,
    role, strategy, isBot: true,
    balance: role === 'dealer' ? 9999 : 1000,
    bet: 0, hand: [],
    stood: false, busted: false, doubled: false,
    hasSplit: false, playingSplit: false,
    splitHand: [], splitBet: 0, splitStood: false, splitBusted: false,
    result: null, gain: null, mainResult: null, splitResult: null,
  };
}

function createRoom(code) {
  return { code, phase:'lobby', players:[], deck:[], currentPlayerIdx:-1, dealerIdx:-1, round:0, hostSocketId:null };
}

function generateCode() { return Math.random().toString(36).substring(2,7).toUpperCase(); }

// ── Helpers ───────────────────────────────────────────────────
function getRoom(socket)              { return rooms[socket.data.roomCode]; }
function getPlayer(socket, room)      { return room.players.find(p => p.socketId === socket.id); }
function isDealerSocket(socket, room) { return getPlayer(socket, room)?.role === 'dealer'; }
function isHostSocket(socket, room)   { return room.hostSocketId === socket.id; }

// Un joueur est "terminé" seulement quand TOUTES ses mains sont jouées
function isPlayerDone(p) {
  if (p.role !== 'player') return true;
  const mainDone = p.stood || p.busted;
  if (!p.hasSplit) return mainDone;
  return mainDone && (p.splitStood || p.splitBusted);
}

function nextPlayerIdx(players, from) {
  for (let i = from + 1; i < players.length; i++) {
    if (players[i].role === 'player' && !isPlayerDone(players[i])) return i;
  }
  return -1;
}

// ── Broadcast ─────────────────────────────────────────────────
function broadcastState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;
  const revealDealer = room.phase === 'dealer' || room.phase === 'results';

  const publicState = {
    ...room,
    players: room.players.map((p, i) => {
      const hideSecond = i === room.dealerIdx && !revealDealer;
      const hand = hideSecond
        ? p.hand.map((c, ci) => ci === 1 ? { hidden:true } : c)
        : p.hand;
      return {
        ...p, hand,
        handTotal:      handTotal(hand),
        splitHandTotal: p.hasSplit ? handTotal(p.splitHand) : 0,
      };
    }),
  };
  io.to(roomCode).emit('state', publicState);
}

// ── Auto-fill rôles manquants ─────────────────────────────────
function autoFillRoles(room) {
  const msgs = [];
  if (!room.players.some(p => p.role === 'dealer')) {
    const bot = makeBot('Croupier 🎩', 'dealer');
    room.players.push(bot);
    room.dealerIdx = room.players.length - 1;
    msgs.push('Croupier bot ajouté automatiquement');
  }
  if (!room.players.some(p => p.role === 'player')) {
    room.players.push(makeBot('Alice', 'player'));
    msgs.push('Joueur bot ajouté automatiquement');
  }
  return msgs;
}

// ── Mises auto bots ───────────────────────────────────────────
function scheduleBotBets(room) {
  room.players.forEach(p => {
    if (!p.isBot) return;
    if (p.role === 'player') {
      const s = BOT_STRATEGIES[p.strategy] || BOT_STRATEGIES.balanced;
      p.bet = Math.min(s.betAmounts[Math.floor(Math.random()*s.betAmounts.length)], p.balance);
    } else if (p.role === 'dealer') {
      p.bet = Math.min(50, p.balance);
    }
  });
}

// ── Init manche ───────────────────────────────────────────────
function initRound(room) {
  room.deck  = buildDeck(2);
  room.phase = 'betting';
  room.round = (room.round || 0) + 1;
  room.currentPlayerIdx = -1;
  room.players.forEach(p => {
    p.hand        = []; p.bet    = 0;
    p.stood       = false; p.busted = false; p.doubled = false;
    p.hasSplit    = false; p.playingSplit = false;
    p.splitHand   = []; p.splitBet = 0;
    p.splitStood  = false; p.splitBusted = false;
    p.result      = null; p.gain = null;
    p.mainResult  = null; p.splitResult = null;
  });
  scheduleBotBets(room);
}

// ── Résolution mise croupier ──────────────────────────────────
function resolveDealerBet(room) {
  const dealer  = room.players[room.dealerIdx];
  if (!dealer || dealer.bet === 0) return;
  const players = room.players.filter(p => p.role === 'player');
  if (players.every(p => p.result === 'lose'))
    dealer.balance += dealer.bet * 2;
  else if (players.every(p => p.result === 'win') || isBust(dealer.hand))
    dealer.balance += 0;
  else
    dealer.balance += dealer.bet;
}

// ── Avancer le tour (gère split) ──────────────────────────────
function advanceTurn(room) {
  const cur = room.players[room.currentPlayerIdx];

  // Si ce joueur vient de finir sa main principale ET a un split non encore joué
  if (cur && cur.hasSplit && !cur.playingSplit
      && (cur.stood || cur.busted)
      && !cur.splitStood && !cur.splitBusted) {
    cur.playingSplit = true;
    io.to(room.code).emit('toast', `${cur.name} — Deuxième main !`);
    broadcastState(room.code);
    if (cur.isBot) scheduleBotPlaySplit(room, room.currentPlayerIdx);
    return;
  }

  const next = nextPlayerIdx(room.players, room.currentPlayerIdx);
  if (next === -1) {
    room.phase = 'dealer';
    room.currentPlayerIdx = -1;
    io.to(room.code).emit('toast', 'Tour du croupier !');
    autoDealerRevealIfBot(room);
  } else {
    room.currentPlayerIdx = next;
    const p = room.players[next];
    io.to(room.code).emit('toast', `Tour de ${p.name}`);
    if (p.isBot) scheduleBotPlay(room, next);
  }
}

// ── Auto croupier bot ─────────────────────────────────────────
function autoDealerRevealIfBot(room) {
  const dealer = room.players[room.dealerIdx];
  if (!dealer?.isBot) return;
  setTimeout(() => {
    if (room.phase !== 'dealer') return;
    dealer.hand.forEach(c => c.hidden = false);
    broadcastState(room.code);
    scheduleDealerPlay(room);
  }, 1200);
}

function scheduleDealerPlay(room) {
  const dealer = room.players[room.dealerIdx];
  if (!dealer) return;
  const total = handTotal(dealer.hand);
  if (total < 17 || isSoft17(dealer.hand)) {
    setTimeout(() => {
      dealer.hand.push({ ...drawCard(room.deck), hidden:false });
      broadcastState(room.code);
      scheduleDealerPlay(room);
    }, 700);
  } else {
    setTimeout(() => {
      room.players = computeResults(room);
      resolveDealerBet(room);
      room.phase = 'results';
      broadcastState(room.code);
    }, 400);
  }
}

// ── Bot joueur (main normale) ─────────────────────────────────
function scheduleBotPlay(room, botIdx) {
  setTimeout(() => {
    if (room.phase !== 'playing' || room.currentPlayerIdx !== botIdx) return;
    const bot   = room.players[botIdx];
    const total = handTotal(bot.hand);
    const strat = BOT_STRATEGIES[bot.strategy] || BOT_STRATEGIES.balanced;

    if (bot.hand.length === 2 && bot.balance >= bot.bet && strat.doubleOn.includes(total)) {
      bot.balance -= bot.bet; bot.bet *= 2; bot.doubled = true;
      bot.hand.push({ ...drawCard(room.deck), hidden:false });
      if (handTotal(bot.hand) > 21) bot.busted = true;
      bot.stood = true;
      advanceTurn(room); broadcastState(room.code);
      return;
    }
    if (total < strat.hitUntil) {
      bot.hand.push({ ...drawCard(room.deck), hidden:false });
      const t = handTotal(bot.hand);
      if (t > 21)        { bot.busted = true; advanceTurn(room); }
      else if (t === 21) { bot.stood  = true; advanceTurn(room); }
      else { broadcastState(room.code); scheduleBotPlay(room, botIdx); return; }
    } else {
      bot.stood = true;
      advanceTurn(room);
    }
    broadcastState(room.code);
  }, 900);
}

// ── Bot joueur (main splitée) ─────────────────────────────────
function scheduleBotPlaySplit(room, botIdx) {
  setTimeout(() => {
    if (room.phase !== 'playing' || room.currentPlayerIdx !== botIdx) return;
    const bot   = room.players[botIdx];
    const total = handTotal(bot.splitHand);
    const strat = BOT_STRATEGIES[bot.strategy] || BOT_STRATEGIES.balanced;

    if (total < strat.hitUntil) {
      bot.splitHand.push({ ...drawCard(room.deck), hidden:false });
      const t = handTotal(bot.splitHand);
      if (t > 21)        { bot.splitBusted = true; advanceTurn(room); }
      else if (t === 21) { bot.splitStood  = true; advanceTurn(room); }
      else { broadcastState(room.code); scheduleBotPlaySplit(room, botIdx); return; }
    } else {
      bot.splitStood = true;
      advanceTurn(room);
    }
    broadcastState(room.code);
  }, 900);
}

// ════════════════════════════════════════════════════════════
//  Socket events
// ════════════════════════════════════════════════════════════
io.on('connection', (socket) => {
  console.log(`[+] ${socket.id}`);

  // ── Créer salle ──────────────────────────────────────────
  socket.on('createRoom', ({ name, role }, cb) => {
    const code = generateCode();
    rooms[code] = createRoom(code);
    rooms[code].hostSocketId = socket.id;
    const player = makePlayer(socket.id, name, role);
    rooms[code].players.push(player);
    if (role === 'dealer') rooms[code].dealerIdx = 0;
    socket.join(code); socket.data.roomCode = code;
    cb({ ok:true, code, playerIndex:0 });
    broadcastState(code);
  });

  // ── Rejoindre salle ───────────────────────────────────────
  socket.on('joinRoom', ({ code, name, role }, cb) => {
    const room = rooms[code];
    if (!room)                  return cb({ ok:false, error:'Room introuvable.' });
    if (room.phase !== 'lobby') return cb({ ok:false, error:'Partie déjà commencée.' });
    const hasDealer   = room.players.some(p => p.role === 'dealer');
    const playerCount = room.players.filter(p => p.role === 'player' && !p.isBot).length;
    if (role === 'dealer' && hasDealer)       return cb({ ok:false, error:'Il y a déjà un croupier.' });
    if (role === 'player' && playerCount >= 4) return cb({ ok:false, error:'Room pleine (4 joueurs max).' });
    const player = makePlayer(socket.id, name, role);
    room.players.push(player);
    if (role === 'dealer') room.dealerIdx = room.players.length - 1;
    socket.join(code); socket.data.roomCode = code;
    io.to(code).emit('toast', `${name} a rejoint !`);
    cb({ ok:true, code, playerIndex:room.players.length - 1 });
    broadcastState(code);
  });

  socket.on('getRooms', (_, cb) => {
    const available = Object.values(rooms)
      .filter(r => r.phase === 'lobby')
      .map(r => ({
        code:    r.code,
        players: r.players.filter(p => p.role === 'player' && !p.isBot).length,
        bots:    r.players.filter(p => p.isBot).length,
        dealer:  r.players.some(p => p.role === 'dealer'),
        host:    r.players.find(p => p.socketId === r.hostSocketId)?.name || '?',
      }));
    cb({ ok:true, rooms: available });
  });

  socket.on('addBot', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'lobby' || !isHostSocket(socket, room)) return cb?.({ ok:false });
    const bots  = room.players.filter(p => p.isBot && p.role === 'player').length;
    const hums  = room.players.filter(p => p.role === 'player' && !p.isBot).length;
    if (hums + bots >= 4) return cb?.({ ok:false, error:'Maximum 4 joueurs.' });
    const names = ['Alice','Bob','Charlie','Diana'];
    const bot   = makeBot(names[bots] || `Bot ${bots+1}`, 'player');
    room.players.push(bot);
    cb?.({ ok:true });
    io.to(room.code).emit('toast', `${bot.name} rejoint !`);
    broadcastState(room.code);
  });

  socket.on('removeBot', ({ botSocketId }, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'lobby' || !isHostSocket(socket, room)) return cb?.({ ok:false });
    room.players   = room.players.filter(p => !(p.socketId === botSocketId && p.isBot));
    room.dealerIdx = room.players.findIndex(p => p.role === 'dealer');
    cb?.({ ok:true }); broadcastState(room.code);
  });

  socket.on('kickPlayer', ({ targetSocketId }, cb) => {
    const room = getRoom(socket);
    if (!room || !isHostSocket(socket, room)) return cb?.({ ok:false });
    const target = room.players.find(p => p.socketId === targetSocketId);
    if (!target || target.socketId === socket.id) return cb?.({ ok:false });
    room.players   = room.players.filter(p => p.socketId !== targetSocketId);
    room.dealerIdx = room.players.findIndex(p => p.role === 'dealer');
    io.to(targetSocketId).emit('kicked', { reason:'Vous avez été expulsé.' });
    io.to(room.code).emit('toast', `${target.name} a été expulsé`);
    cb?.({ ok:true }); broadcastState(room.code);
  });

  socket.on('getInviteCode', (_, cb) => {
    const room = getRoom(socket);
    if (!room) return cb?.({ ok:false });
    cb?.({ ok:true, code:room.code });
  });

  // ── Démarrer ─────────────────────────────────────────────
  socket.on('startGame', (_, cb) => {
    const room = getRoom(socket);
    if (!room) return cb?.({ ok:false, error:'Room introuvable.' });
    const me = getPlayer(socket, room);
    if (!me) return cb?.({ ok:false });
    if (me.role !== 'dealer' && !isHostSocket(socket, room))
      return cb?.({ ok:false, error:"Seul le croupier ou l'hôte peut démarrer." });
    const msgs = autoFillRoles(room);
    msgs.forEach(m => setTimeout(() => io.to(room.code).emit('toast', m), 300));
    room.dealerIdx = room.players.findIndex(p => p.role === 'dealer');
    initRound(room); broadcastState(room.code);
    cb?.({ ok:true });
  });

  // ── Mise (joueurs ET croupier humain) ────────────────────
  socket.on('placeBet', ({ amount }, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'betting') return cb?.({ ok:false });
    const p = getPlayer(socket, room);
    if (!p || p.isBot) return cb?.({ ok:false });
    if (p.balance - p.bet < amount) return cb?.({ ok:false, error:'Solde insuffisant.' });
    p.bet += amount; cb?.({ ok:true }); broadcastState(room.code);
  });

  socket.on('clearBet', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'betting') return;
    const p = getPlayer(socket, room);
    if (!p || p.isBot) return;
    p.bet = 0; cb?.({ ok:true }); broadcastState(room.code);
  });

  // ── Distribuer (croupier OU hôte) ─────────────────────────
  socket.on('dealCards', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'betting') return cb?.({ ok:false });
    // ✅ L'hôte peut distribuer même s'il est joueur (vs bot croupier)
    if (!isDealerSocket(socket, room) && !isHostSocket(socket, room))
      return cb?.({ ok:false, error:"Seul le croupier ou l'hôte peut distribuer." });

    const unbetted = room.players.filter(p => p.role === 'player' && !p.isBot && p.bet === 0);
    if (unbetted.length > 0)
      return cb?.({ ok:false, error:`${unbetted[0].name} n'a pas encore misé.` });

    // Déduire mises
    room.players.forEach(p => { if (p.role === 'player') p.balance -= p.bet; });
    const dealer = room.players[room.dealerIdx];
    if (dealer && dealer.bet > 0 && !dealer.isBot) dealer.balance -= dealer.bet;

    // Distribuer 2 cartes
    room.players.forEach(p => {
      p.hand.push({ ...drawCard(room.deck), hidden:false });
      p.hand.push({ ...drawCard(room.deck), hidden:false });
    });
    dealer.hand[1].hidden = true;

    // Blackjacks naturels
    room.players.forEach(p => {
      if (p.role === 'player' && isBlackjack(p.hand)) {
        p.stood = true;
        io.to(room.code).emit('blackjack', { name: p.name });
        setTimeout(() => io.to(room.code).emit('toast', `${p.name} — Blackjack ! ♠`), 600);
      }
    });
    if (isBlackjack(dealer.hand)) {
      dealer.hand.forEach(c => c.hidden = false);
      io.to(room.code).emit('blackjack', { name:`${dealer.name} (Croupier)` });
    }

    room.phase = 'playing';
    room.currentPlayerIdx = nextPlayerIdx(room.players, -1);
    if (room.currentPlayerIdx === -1) {
      room.phase = 'dealer';
      io.to(room.code).emit('toast', 'Tous en Blackjack !');
      autoDealerRevealIfBot(room);
    } else {
      const cur = room.players[room.currentPlayerIdx];
      io.to(room.code).emit('toast', `Tour de ${cur.name}`);
      if (cur.isBot) scheduleBotPlay(room, room.currentPlayerIdx);
    }
    cb?.({ ok:true }); broadcastState(room.code);
  });

  // ── Tirer (gère split) ────────────────────────────────────
  socket.on('hit', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'playing') return cb?.({ ok:false });
    const p   = getPlayer(socket, room);
    const idx = room.players.indexOf(p);
    if (idx !== room.currentPlayerIdx || p?.isBot) return cb?.({ ok:false, error:'Pas ton tour.' });

    if (p.playingSplit) {
      p.splitHand.push({ ...drawCard(room.deck), hidden:false });
      const t = handTotal(p.splitHand);
      if (t > 21)        { p.splitBusted = true; advanceTurn(room); }
      else if (t === 21) { p.splitStood  = true; advanceTurn(room); }
    } else {
      p.hand.push({ ...drawCard(room.deck), hidden:false });
      const t = handTotal(p.hand);
      if (t > 21)        { p.busted = true; advanceTurn(room); }
      else if (t === 21) { p.stood  = true; advanceTurn(room); }
    }
    cb?.({ ok:true }); broadcastState(room.code);
  });

  // ── Rester (gère split) ───────────────────────────────────
  socket.on('stand', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'playing') return cb?.({ ok:false });
    const p = getPlayer(socket, room);
    if (room.players.indexOf(p) !== room.currentPlayerIdx || p?.isBot) return cb?.({ ok:false });

    if (p.playingSplit) p.splitStood = true;
    else                p.stood      = true;
    advanceTurn(room);
    cb?.({ ok:true }); broadcastState(room.code);
  });

  // ── Double (gère split) ───────────────────────────────────
  socket.on('double', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'playing') return cb?.({ ok:false });
    const p = getPlayer(socket, room);
    if (room.players.indexOf(p) !== room.currentPlayerIdx || p?.isBot) return cb?.({ ok:false });

    if (p.playingSplit) {
      if (p.splitHand.length !== 2 || p.balance < p.splitBet)
        return cb?.({ ok:false, error:'Double impossible.' });
      p.balance -= p.splitBet; p.splitBet *= 2;
      p.splitHand.push({ ...drawCard(room.deck), hidden:false });
      if (handTotal(p.splitHand) > 21) p.splitBusted = true;
      p.splitStood = true;
    } else {
      if (p.hand.length !== 2 || p.balance < p.bet)
        return cb?.({ ok:false, error:'Double impossible.' });
      p.balance -= p.bet; p.bet *= 2; p.doubled = true;
      p.hand.push({ ...drawCard(room.deck), hidden:false });
      if (handTotal(p.hand) > 21) p.busted = true;
      p.stood = true;
    }
    advanceTurn(room);
    cb?.({ ok:true }); broadcastState(room.code);
  });

  // ── Split ─────────────────────────────────────────────────
  socket.on('split', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'playing') return cb?.({ ok:false });
    const p   = getPlayer(socket, room);
    const idx = room.players.indexOf(p);
    if (idx !== room.currentPlayerIdx || p?.isBot) return cb?.({ ok:false, error:'Pas ton tour.' });
    if (p.hasSplit) return cb?.({ ok:false, error:'Déjà splitté.' });
    if (!canSplit(p.hand))   return cb?.({ ok:false, error:'Cartes différentes — split impossible.' });
    if (p.balance < p.bet)   return cb?.({ ok:false, error:'Solde insuffisant pour split.' });

    // Déduire la mise du split
    p.balance   -= p.bet;
    p.splitBet   = p.bet;
    p.hasSplit   = true;
    p.playingSplit = false;

    // Séparer les cartes et en distribuer une nouvelle à chaque main
    const secondCard = p.hand.pop();
    p.splitHand  = [secondCard, { ...drawCard(room.deck), hidden:false }];
    p.hand.push({ ...drawCard(room.deck), hidden:false });

    io.to(room.code).emit('toast', `${p.name} — Split ! ✂️`);
    cb?.({ ok:true }); broadcastState(room.code);
  });

  // ── Croupier révèle ───────────────────────────────────────
  socket.on('dealerReveal', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'dealer' || !isDealerSocket(socket, room)) return cb?.({ ok:false });
    room.players[room.dealerIdx].hand.forEach(c => c.hidden = false);
    cb?.({ ok:true }); broadcastState(room.code);
    scheduleDealerPlay(room);
  });

  // ── Nouvelle manche ───────────────────────────────────────
  socket.on('newRound', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'results') return cb?.({ ok:false });
    const me = getPlayer(socket, room);
    if (!me || (me.role !== 'dealer' && !isHostSocket(socket, room))) return cb?.({ ok:false });
    room.players   = room.players.filter(p => p.role === 'dealer' || p.isBot || p.balance > 0);
    room.dealerIdx = room.players.findIndex(p => p.role === 'dealer');
    if (room.players.filter(p => p.role === 'player').length === 0) {
      io.to(room.code).emit('toast', 'Plus de joueurs solvables !');
      room.phase = 'lobby'; broadcastState(room.code);
      return cb?.({ ok:true });
    }
    initRound(room); cb?.({ ok:true }); broadcastState(room.code);
  });

  // ── Quitter salle ─────────────────────────────────────────
  socket.on('leaveRoom', (_, cb) => {
    const room = getRoom(socket);
    if (!room) return cb?.({ ok:false });
    const idx = room.players.findIndex(p => p.socketId === socket.id);
    if (idx === room.currentPlayerIdx && room.phase === 'playing') {
      const p = room.players[idx];
      if (p.playingSplit) { p.splitStood = true; }
      else { p.stood = true; }
      advanceTurn(room);
    }
    const leaving = room.players.find(p => p.socketId === socket.id);
    room.players  = room.players.filter(p => p.socketId !== socket.id);
    if (room.hostSocketId === socket.id && room.players.length > 0) {
      const newHost = room.players.find(p => !p.isBot) || room.players[0];
      room.hostSocketId = newHost.socketId;
      io.to(newHost.socketId).emit('toast', "Vous êtes maintenant l'hôte 👑");
    }
    socket.leave(room.code); socket.data.roomCode = null;
    if (room.players.length === 0 || room.players.every(p => p.isBot)) {
      delete rooms[room.code];
    } else {
      room.dealerIdx = room.players.findIndex(p => p.role === 'dealer');
      if (leaving) io.to(room.code).emit('toast', `${leaving.name} a quitté`);
      broadcastState(room.code);
    }
    cb?.({ ok:true });
  });

  // ── Déconnexion ───────────────────────────────────────────
  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    const idx  = room.players.findIndex(p => p.socketId === socket.id);
    if (idx === room.currentPlayerIdx && room.phase === 'playing') {
      const p = room.players[idx];
      if (p.playingSplit) p.splitStood = true; else p.stood = true;
      advanceTurn(room);
    }
    const leaving = room.players.find(p => p.socketId === socket.id);
    room.players  = room.players.filter(p => p.socketId !== socket.id);
    if (room.hostSocketId === socket.id && room.players.length > 0) {
      const nh = room.players.find(p => !p.isBot) || room.players[0];
      if (nh) { room.hostSocketId = nh.socketId; io.to(nh.socketId).emit('toast', "Vous êtes l'hôte 👑"); }
    }
    if (room.players.length === 0 || room.players.every(p => p.isBot)) {
      delete rooms[code];
    } else {
      room.dealerIdx = room.players.findIndex(p => p.role === 'dealer');
      if (leaving) io.to(code).emit('toast', `${leaving.name} s'est déconnecté`);
      broadcastState(code);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🃏 BlackJack → http://localhost:${PORT}`));

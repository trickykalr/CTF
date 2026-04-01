// ═══════════════════════════════════════════════════════════
//  server.js — Serveur Node.js + Socket.io
//  Gestion des rooms, flux du jeu, broadcast d'état
// ═══════════════════════════════════════════════════════════

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const path      = require('path');
const {
  buildDeck, drawCard, handTotal,
  isBust, isBlackjack, isSoft17, computeResults
} = require('./gameLogic');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, '../client')));

// ── Rooms ────────────────────────────────────────────────────
// rooms[roomCode] = { gameState }
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

/**
 * État initial d'une room.
 */
function createRoom(code) {
  return {
    code,
    phase: 'lobby',      // lobby | betting | playing | dealer | results
    players: [],         // { socketId, name, role, balance, bet, hand, stood, busted, doubled, result, gain }
    deck: [],
    currentPlayerIdx: -1,
    dealerIdx: -1,
    round: 0,
  };
}

// ── Helper : broadcast l'état à toute la room ─────────────────
function broadcastState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // On envoie l'état publique : masquer la carte cachée du croupier
  const publicState = {
    ...room,
    players: room.players.map((p, i) => {
      if (i === room.dealerIdx && room.phase !== 'dealer' && room.phase !== 'results') {
        return {
          ...p,
          hand: p.hand.map((c, ci) => (ci === 1 && c.hidden ? { hidden: true } : c))
        };
      }
      return p;
    }),
  };

  io.to(roomCode).emit('state', publicState);
}

// ── Helper : trouver le prochain joueur actif ──────────────────
function nextPlayerIdx(players, from) {
  for (let i = from + 1; i < players.length; i++) {
    const p = players[i];
    if (p.role === 'player' && !p.stood && !p.busted) return i;
  }
  return -1;
}

// ── Socket events ─────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[+] Connexion : ${socket.id}`);

  // ── Créer une room ──────────────────────────────────────────
  socket.on('createRoom', ({ name, role }, cb) => {
    const code = generateCode();
    rooms[code] = createRoom(code);
    const player = {
      socketId: socket.id, name, role,
      balance: 1000, bet: 0, hand: [],
      stood: false, busted: false, doubled: false,
      result: null, gain: null
    };
    rooms[code].players.push(player);
    if (role === 'dealer') rooms[code].dealerIdx = 0;

    socket.join(code);
    socket.data.roomCode = code;
    cb({ ok: true, code, playerIndex: 0 });
    broadcastState(code);
  });

  // ── Rejoindre une room ──────────────────────────────────────
  socket.on('joinRoom', ({ code, name, role }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Room introuvable.' });
    if (room.phase !== 'lobby') return cb({ ok: false, error: 'Partie déjà commencée.' });

    const totalPlayers = room.players.filter(p => p.role === 'player').length;
    const hasDealer    = room.players.some(p => p.role === 'dealer');

    if (role === 'dealer' && hasDealer)
      return cb({ ok: false, error: 'Il y a déjà un croupier dans cette room.' });
    if (role === 'player' && totalPlayers >= 4)
      return cb({ ok: false, error: 'La room est pleine (4 joueurs max).' });

    const player = {
      socketId: socket.id, name, role,
      balance: 1000, bet: 0, hand: [],
      stood: false, busted: false, doubled: false,
      result: null, gain: null
    };
    room.players.push(player);
    if (role === 'dealer') room.dealerIdx = room.players.length - 1;

    socket.join(code);
    socket.data.roomCode = code;
    const playerIndex = room.players.length - 1;
    cb({ ok: true, code, playerIndex });
    broadcastState(code);
  });

  // ── Démarrer la partie (croupier seulement) ─────────────────
  socket.on('startGame', (_, cb) => {
    const room = getRoom(socket);
    if (!room) return cb?.({ ok: false, error: 'Room introuvable.' });

    const dealer  = room.players.some(p => p.role === 'dealer');
    const players = room.players.filter(p => p.role === 'player');

    if (!dealer)         return cb?.({ ok: false, error: 'Aucun croupier.' });
    if (players.length < 1) return cb?.({ ok: false, error: 'Au moins 1 joueur requis.' });
    if (!isDealerSocket(socket, room)) return cb?.({ ok: false, error: 'Seul le croupier peut démarrer.' });

    initRound(room);
    broadcastState(room.code);
    cb?.({ ok: true });
  });

  // ── Placer une mise ─────────────────────────────────────────
  socket.on('placeBet', ({ amount }, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'betting') return cb?.({ ok: false });

    const p = getPlayer(socket, room);
    if (!p || p.role !== 'player') return cb?.({ ok: false });

    if (p.balance - p.bet < amount) return cb?.({ ok: false, error: 'Solde insuffisant.' });
    p.bet += amount;
    cb?.({ ok: true });
    broadcastState(room.code);
  });

  socket.on('clearBet', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'betting') return;
    const p = getPlayer(socket, room);
    if (!p || p.role !== 'player') return;
    p.bet = 0;
    cb?.({ ok: true });
    broadcastState(room.code);
  });

  // ── Distribuer les cartes (croupier) ────────────────────────
  socket.on('dealCards', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'betting') return cb?.({ ok: false });
    if (!isDealerSocket(socket, room)) return cb?.({ ok: false, error: 'Seul le croupier distribue.' });

    const unbetted = room.players.filter(p => p.role === 'player' && p.bet === 0);
    if (unbetted.length > 0)
      return cb?.({ ok: false, error: `${unbetted[0].name} n'a pas encore misé.` });

    // Déduire les mises
    room.players.forEach(p => { if (p.role === 'player') p.balance -= p.bet; });

    // Distribuer 2 cartes
    room.players.forEach(p => {
      p.hand.push({ ...drawCard(room.deck), hidden: false });
      p.hand.push({ ...drawCard(room.deck), hidden: false });
    });

    // Cacher la 2e carte du croupier
    room.players[room.dealerIdx].hand[1].hidden = true;

    // Blackjacks immédiats
    room.players.forEach(p => {
      if (p.role === 'player' && isBlackjack(p.hand)) p.stood = true;
    });

    room.phase = 'playing';
    room.currentPlayerIdx = nextPlayerIdx(room.players, -1);
    if (room.currentPlayerIdx === -1) {
      room.phase = 'dealer';
      io.to(room.code).emit('toast', 'Tour du croupier !');
    } else {
      io.to(room.code).emit('toast', `Tour de ${room.players[room.currentPlayerIdx].name}`);
    }

    cb?.({ ok: true });
    broadcastState(room.code);
  });

  // ── Actions joueur ──────────────────────────────────────────
  socket.on('hit', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'playing') return cb?.({ ok: false });

    const p = getPlayer(socket, room);
    const idx = room.players.indexOf(p);
    if (idx !== room.currentPlayerIdx) return cb?.({ ok: false, error: 'Pas ton tour.' });

    p.hand.push({ ...drawCard(room.deck), hidden: false });
    const total = handTotal(p.hand);

    if (total > 21)      { p.busted = true; advanceTurn(room); }
    else if (total === 21) { p.stood  = true; advanceTurn(room); }

    cb?.({ ok: true });
    broadcastState(room.code);
  });

  socket.on('stand', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'playing') return cb?.({ ok: false });
    const p = getPlayer(socket, room);
    if (room.players.indexOf(p) !== room.currentPlayerIdx) return cb?.({ ok: false });

    p.stood = true;
    advanceTurn(room);
    cb?.({ ok: true });
    broadcastState(room.code);
  });

  socket.on('double', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'playing') return cb?.({ ok: false });
    const p = getPlayer(socket, room);
    if (room.players.indexOf(p) !== room.currentPlayerIdx) return cb?.({ ok: false });
    if (p.hand.length !== 2 || p.balance < p.bet) return cb?.({ ok: false });

    p.balance -= p.bet;
    p.bet     *= 2;
    p.doubled  = true;
    p.hand.push({ ...drawCard(room.deck), hidden: false });
    if (handTotal(p.hand) > 21) p.busted = true;
    p.stood = true;
    advanceTurn(room);
    cb?.({ ok: true });
    broadcastState(room.code);
  });

  // ── Révélation + jeu du croupier ────────────────────────────
  socket.on('dealerReveal', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'dealer') return cb?.({ ok: false });
    if (!isDealerSocket(socket, room)) return cb?.({ ok: false });

    const dealer = room.players[room.dealerIdx];
    dealer.hand.forEach(c => (c.hidden = false));

    cb?.({ ok: true });
    broadcastState(room.code);

    // Auto-play dealer avec délai pour l'animation
    scheduleDealerPlay(room);
  });

  // ── Nouvelle manche (croupier) ───────────────────────────────
  socket.on('newRound', (_, cb) => {
    const room = getRoom(socket);
    if (!room || room.phase !== 'results') return cb?.({ ok: false });
    if (!isDealerSocket(socket, room)) return cb?.({ ok: false });

    // Supprimer joueurs à court d'argent
    room.players = room.players.filter(p => p.role === 'dealer' || p.balance > 0);
    room.dealerIdx = room.players.findIndex(p => p.role === 'dealer');

    if (room.players.filter(p => p.role === 'player').length === 0) {
      io.to(room.code).emit('toast', 'Plus de joueurs solvables !');
      room.phase = 'lobby';
      broadcastState(room.code);
      return cb?.({ ok: true });
    }

    initRound(room);
    cb?.({ ok: true });
    broadcastState(room.code);
  });

  // ── Déconnexion ─────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] Déconnexion : ${socket.id}`);
    const code = socket.data.roomCode;
    if (!code || !rooms[code]) return;
    const room = rooms[code];
    room.players = room.players.filter(p => p.socketId !== socket.id);
    if (room.players.length === 0) {
      delete rooms[code];
    } else {
      room.dealerIdx = room.players.findIndex(p => p.role === 'dealer');
      broadcastState(code);
    }
  });
});

// ── Helpers internes ──────────────────────────────────────────
function getRoom(socket)   { return rooms[socket.data.roomCode]; }
function getPlayer(socket, room) {
  return room.players.find(p => p.socketId === socket.id);
}
function isDealerSocket(socket, room) {
  const p = getPlayer(socket, room);
  return p && p.role === 'dealer';
}

function initRound(room) {
  room.deck    = buildDeck(2);
  room.phase   = 'betting';
  room.round   = (room.round || 0) + 1;
  room.currentPlayerIdx = -1;
  room.players.forEach(p => {
    p.hand    = [];
    p.bet     = 0;
    p.stood   = false;
    p.busted  = false;
    p.doubled = false;
    p.result  = null;
    p.gain    = null;
  });
}

function advanceTurn(room) {
  const next = nextPlayerIdx(room.players, room.currentPlayerIdx);
  if (next === -1) {
    room.phase = 'dealer';
    room.currentPlayerIdx = -1;
    io.to(room.code).emit('toast', 'Tour du croupier !');
  } else {
    room.currentPlayerIdx = next;
    io.to(room.code).emit('toast', `Tour de ${room.players[next].name}`);
  }
}

function scheduleDealerPlay(room) {
  const dealer = room.players[room.dealerIdx];
  const total  = handTotal(dealer.hand);

  // Règle standard : tire jusqu'à >= 17 (y compris soft 17)
  if (total < 17 || (total === 17 && isSoft17(dealer.hand))) {
    setTimeout(() => {
      dealer.hand.push({ ...drawCard(room.deck), hidden: false });
      broadcastState(room.code);
      scheduleDealerPlay(room);
    }, 700);
  } else {
    // Fin du tour du croupier
    setTimeout(() => {
      room.players = computeResults(room);
      room.phase   = 'results';
      broadcastState(room.code);
    }, 400);
  }
}

// ── Démarrage ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🃏 BlackJack server running on http://localhost:${PORT}`);
});
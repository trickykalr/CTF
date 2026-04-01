// ═══════════════════════════════════════════════════════════
//  client.js — Pont entre Socket.io et l'interface visuelle
//  Ce fichier NE contient PAS de logique de jeu ni de DOM brut.
//  Il écoute le serveur et délègue :
//    → les données brutes à ui.js (rendu)
//    → les actions utilisateur au serveur via socket
// ═══════════════════════════════════════════════════════════

const socket = io(); // connexion automatique au serveur

// ── État local minimal (pas de logique, juste pour le rendu) ──
let mySocketId  = null;
let currentState = null;

// ── Connexion établie ─────────────────────────────────────────
socket.on('connect', () => {
  mySocketId = socket.id;
  console.log('Connecté :', mySocketId);
});

// ── Réception de l'état (broadcast serveur) ──────────────────
socket.on('state', (state) => {
  currentState = state;
  syncScreens(state);
});

// ── Toasts serveur ────────────────────────────────────────────
socket.on('toast', (msg) => {
  UI.showToast(msg);
});

// ── Gestion des écrans ────────────────────────────────────────
function syncScreens(state) {
  const screens = {
    lobby:   document.getElementById('screenLobby'),
    game:    document.getElementById('screenGame'),
    results: document.getElementById('screenResults'),
  };

  // Masquer tous, afficher le bon
  Object.values(screens).forEach(s => s && (s.style.display = 'none'));

  if (state.phase === 'lobby') {
    screens.lobby.style.display = 'flex';
    UI.renderLobby(state, mySocketId);
    return;
  }

  if (state.phase === 'results') {
    screens.results.style.display = 'block';
    UI.renderResults(state, mySocketId);
    return;
  }

  screens.game.style.display = 'block';
  UI.renderAll(state, mySocketId);
}

// ── Actions exposées au DOM via window.gameActions ────────────
// ui.js appelle ces fonctions via onclick="window.gameActions.xxx()"
window.gameActions = {

  // Mises
  placeBet(amount) {
    socket.emit('placeBet', { amount }, (res) => {
      if (!res?.ok) UI.showToast(res?.error || 'Erreur mise');
    });
  },

  clearBet() {
    socket.emit('clearBet');
  },

  // Croupier
  dealCards() {
    socket.emit('dealCards', null, (res) => {
      if (!res?.ok) UI.showToast(res?.error || 'Impossible de distribuer');
    });
  },

  dealerReveal() {
    socket.emit('dealerReveal', null, (res) => {
      if (!res?.ok) UI.showToast(res?.error || 'Erreur révélation');
    });
  },

  // Joueur
  hit() {
    socket.emit('hit', null, (res) => {
      if (!res?.ok) UI.showToast(res?.error || 'Erreur');
    });
  },

  stand() {
    socket.emit('stand', null, (res) => {
      if (!res?.ok) UI.showToast(res?.error || 'Erreur');
    });
  },

  double() {
    socket.emit('double', null, (res) => {
      if (!res?.ok) UI.showToast(res?.error || 'Erreur double');
    });
  },

  // Nouvelle manche (croupier)
  newRound() {
    socket.emit('newRound', null, (res) => {
      if (!res?.ok) UI.showToast(res?.error || 'Erreur');
    });
  },

  // Retour lobby (reload simple)
  backToLobby() {
    window.location.reload();
  },
};

// ── Formulaire d'accueil : créer ou rejoindre une room ────────
document.getElementById('formJoin')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const name   = document.getElementById('inputName').value.trim();
  const role   = document.getElementById('selectRole').value;
  const action = document.querySelector('[name=action]:checked')?.value || 'create';
  const code   = document.getElementById('inputCode')?.value.trim().toUpperCase();
  const errEl  = document.getElementById('joinError');

  if (!name) { errEl.textContent = 'Entrez votre nom.'; return; }

  errEl.textContent = '';

  if (action === 'create') {
    socket.emit('createRoom', { name, role }, (res) => {
      if (!res.ok) { errEl.textContent = res.error; return; }
      document.getElementById('roomCodeDisplay').textContent = res.code;
      document.getElementById('roomCodeBanner').style.display = '';
    });
  } else {
    if (!code) { errEl.textContent = 'Entrez le code de la room.'; return; }
    socket.emit('joinRoom', { code, name, role }, (res) => {
      if (!res.ok) { errEl.textContent = res.error; return; }
    });
  }
});

// ── Toggle affichage du champ code ───────────────────────────
document.querySelectorAll('[name=action]').forEach(radio => {
  radio.addEventListener('change', () => {
    const codeField = document.getElementById('codeField');
    if (codeField) codeField.style.display = radio.value === 'join' ? '' : 'none';
  });
});

// Bouton démarrer (affiché seulement pour le croupier dans ui.js)
document.getElementById('btnStart')?.addEventListener('click', () => {
  socket.emit('startGame', null, (res) => {
    if (!res?.ok) UI.showToast(res?.error || 'Impossible de démarrer');
  });
});
// ═══════════════════════════════════════════════════════════
//  ui.js — Rendu visuel uniquement
//  Ce fichier ne contient AUCUNE logique de jeu.
//  Il reçoit un état (gameState) et met à jour le DOM.
// ═══════════════════════════════════════════════════════════

const RED_SUITS = ['♥', '♦'];

// ── Cartes ───────────────────────────────────────────────────
function renderCard(card) {
  if (card.hidden) {
    return `<div class="card hidden"></div>`;
  }
  const isRed = RED_SUITS.includes(card.suit);
  return `
    <div class="card ${isRed ? 'red' : 'black-card'}">
      <span class="card-val">${card.rank}</span>
      <span class="card-suit">${card.suit}</span>
    </div>`;
}

function renderHandValue(hand) {
  const hasHidden = hand.some(c => c.hidden);
  if (hasHidden || hand.length === 0) return '';

  const total = hand.reduce((acc, c) => {
    if (c.hidden) return acc;
    let v = ['J','Q','K'].includes(c.rank) ? 10 : c.rank === 'A' ? 11 : parseInt(c.rank);
    return acc + v;
  }, 0);
  // Simple display (le vrai calcul est côté serveur, ici c'est juste l'affichage)
  return `Score : ${total > 21 ? `<span class="bust">Bust</span>` : total}`;
}

// ── Lobby ────────────────────────────────────────────────────
function renderLobby(state, mySocketId) {
  const list = document.getElementById('lobbyPlayersList');
  if (!list) return;
  list.innerHTML = '';

  state.players.forEach(p => {
    const isMe = p.socketId === mySocketId;
    const li = document.createElement('li');
    li.className = `lobby-player ${isMe ? 'me' : ''}`;
    li.innerHTML = `
      <span class="lp-role">${p.role === 'dealer' ? '🎩' : '🃏'}</span>
      <span class="lp-name">${p.name}${isMe ? ' <em>(vous)</em>' : ''}</span>
      <span class="lp-balance">1000$</span>
    `;
    list.appendChild(li);
  });

  // Bouton start visible seulement pour le croupier
  const btnStart = document.getElementById('btnStart');
  if (btnStart) {
    const me = state.players.find(p => p.socketId === mySocketId);
    btnStart.style.display = me?.role === 'dealer' ? '' : 'none';
  }
}

// ── Phase de mise ─────────────────────────────────────────────
function renderBetting(state, mySocketId) {
  const me = state.players.find(p => p.socketId === mySocketId);
  if (!me || me.role === 'dealer') return;

  const betEl = document.getElementById('myBetAmount');
  if (betEl) betEl.textContent = me.bet + '$';

  const clearBtn = document.getElementById('btnClearBet');
  if (clearBtn) clearBtn.style.display = me.bet > 0 ? '' : 'none';
}

// ── Zone croupier ─────────────────────────────────────────────
function renderDealerZone(state, mySocketId) {
  const dealer = state.players[state.dealerIdx];
  if (!dealer) return;

  const nameEl = document.getElementById('dealerName');
  if (nameEl) nameEl.textContent = dealer.name;

  const handEl = document.getElementById('dealerHand');
  if (handEl) handEl.innerHTML = dealer.hand.map(renderCard).join('');

  const valEl = document.getElementById('dealerValue');
  if (valEl) {
    valEl.innerHTML = dealer.hand.length > 0 ? renderHandValue(dealer.hand) : '';
  }

  // Actions croupier
  const isDealer = dealer.socketId === mySocketId;
  const actionsEl = document.getElementById('dealerActions');
  if (!actionsEl) return;

  actionsEl.innerHTML = '';
  if (!isDealer) return;

  if (state.phase === 'betting') {
    actionsEl.innerHTML = `
      <button class="btn-dealer" onclick="window.gameActions.dealCards()">
        Distribuer les cartes
      </button>`;
  } else if (state.phase === 'dealer') {
    actionsEl.innerHTML = `
      <button class="btn-dealer" onclick="window.gameActions.dealerReveal()">
        Révéler & Jouer
      </button>`;
  }
}

// ── Zone joueurs ──────────────────────────────────────────────
function renderPlayersZone(state, mySocketId) {
  const zone = document.getElementById('playersZone');
  if (!zone) return;
  zone.innerHTML = '';

  state.players.forEach((p, idx) => {
    if (p.role === 'dealer') return;

    const isMe     = p.socketId === mySocketId;
    const isActive = idx === state.currentPlayerIdx && state.phase === 'playing';
    const isDone   = p.stood || p.busted;

    const div = document.createElement('div');
    div.className = `player-card ${isActive ? 'active' : ''} ${isDone && !isActive ? 'done' : ''}`;
    div.id = `pcard-${idx}`;

    // Badge statut
    let badge = '';
    if (isActive)   badge = `<div class="active-badge">Votre tour</div>`;
    if (p.busted)   badge = `<div class="active-badge bust-badge">Bust!</div>`;
    else if (p.stood) badge = `<div class="active-badge stand-badge">Stand</div>`;

    // Section mise
    let betSection = '';
    if (state.phase === 'betting' && isMe) {
      betSection = `
        <div class="bet-section">
          <div class="bet-label">Mise</div>
          <div class="chips">
            <div class="chip c5"   onclick="window.gameActions.placeBet(5)">5</div>
            <div class="chip c10"  onclick="window.gameActions.placeBet(10)">10</div>
            <div class="chip c25"  onclick="window.gameActions.placeBet(25)">25</div>
            <div class="chip c50"  onclick="window.gameActions.placeBet(50)">50</div>
            <div class="chip c100" onclick="window.gameActions.placeBet(100)">100</div>
          </div>
          <div class="bet-display">
            Mise : <span class="bet-amount">${p.bet}$</span>
            ${p.bet > 0 ? `<button class="btn-clear-bet" onclick="window.gameActions.clearBet()">✕</button>` : ''}
          </div>
        </div>`;
    } else if (p.bet > 0) {
      betSection = `<div class="bet-display" style="margin-bottom:10px">
        Mise : <span class="bet-amount">${p.bet}$</span>
      </div>`;
    }

    // Actions joueur actif
    let actions = '';
    if (isActive && isMe && state.phase === 'playing') {
      const canDouble = p.hand.length === 2 && p.balance >= p.bet;
      actions = `
        <div class="player-actions">
          <button class="btn-action btn-hit"   onclick="window.gameActions.hit()">Tirer</button>
          <button class="btn-action btn-stand" onclick="window.gameActions.stand()">Rester</button>
          ${canDouble ? `<button class="btn-action btn-double" onclick="window.gameActions.double()">Double</button>` : ''}
        </div>`;
    }

    div.innerHTML = `
      ${badge}
      <div class="player-card-name">${p.name}${isMe ? ' <em style="font-size:0.75rem;opacity:0.6">(vous)</em>' : ''}</div>
      <div class="player-balance">Solde : ${p.balance}$</div>
      ${betSection}
      <div class="hand" id="hand-${idx}">${p.hand.map(renderCard).join('')}</div>
      ${p.hand.length > 0 ? `<div class="hand-value">${renderHandValue(p.hand)}</div>` : ''}
      ${actions}
    `;
    zone.appendChild(div);
  });
}

// ── Résultats ────────────────────────────────────────────────
function renderResults(state, mySocketId) {
  const grid = document.getElementById('resultsGrid');
  if (!grid) return;
  grid.innerHTML = '';

  state.players.filter(p => p.role === 'player').forEach((p, i) => {
    const label    = p.result === 'win' ? 'Gagné !' : p.result === 'push' ? 'Égalité' : 'Perdu';
    const gainText = p.gain > 0 ? `+${p.gain}$` : p.gain === 0 ? '±0$' : `${p.gain}$`;
    const pHand    = p.hand.map(c => `${c.rank}${c.suit}`).join(' ');
    const isMe     = p.socketId === mySocketId;

    const card = document.createElement('div');
    card.className = `result-card ${p.result || ''}`;
    card.style.animationDelay = `${i * 0.1}s`;
    card.innerHTML = `
      <div class="result-name">${p.name}${isMe ? ' ⭐' : ''}</div>
      <div style="font-size:0.85rem;color:rgba(245,239,224,0.5);margin-bottom:10px">${pHand}</div>
      <div class="result-outcome ${p.result || ''}">${label}</div>
      <div class="result-money">${gainText}</div>
      <div class="result-balance">Solde : ${p.balance}$</div>
    `;
    grid.appendChild(card);
  });

  // Score final croupier
  const dealer = state.players[state.dealerIdx];
  const dealerScoreEl = document.getElementById('dealerFinalScore');
  if (dealerScoreEl && dealer) {
    const total = dealer.hand.reduce((acc, c) => {
      let v = ['J','Q','K'].includes(c.rank) ? 10 : c.rank === 'A' ? 11 : parseInt(c.rank);
      return acc + v;
    }, 0);
    dealerScoreEl.textContent = total > 21 ? `Bust (${total})` : String(total);
  }

  // Bouton nouvelle manche visible seulement pour le croupier
  const me = state.players.find(p => p.socketId === mySocketId);
  const btnNewRound = document.getElementById('btnNewRound');
  if (btnNewRound) btnNewRound.style.display = me?.role === 'dealer' ? '' : 'none';
}

// ── Phase banner ──────────────────────────────────────────────
function renderPhaseBanner(state) {
  const el = document.getElementById('phaseBanner');
  if (!el) return;
  const banners = {
    lobby:   'Salle d\'attente',
    betting: 'Phase de mise — Placez vos paris',
    playing: state.currentPlayerIdx >= 0
      ? `Tour de ${state.players[state.currentPlayerIdx]?.name || ''}`
      : '',
    dealer:  `Tour du croupier`,
    results: 'Fin de la manche ✦',
  };
  el.textContent = banners[state.phase] || '';
}

// ── Rendu global (point d'entrée appelé par client.js) ────────
function renderAll(state, mySocketId) {
  renderPhaseBanner(state);
  renderDealerZone(state, mySocketId);
  renderPlayersZone(state, mySocketId);
  if (state.phase === 'betting') renderBetting(state, mySocketId);
}

// ── Toast ─────────────────────────────────────────────────────
let _toastTimeout;
function showToast(msg) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(_toastTimeout);
  _toastTimeout = setTimeout(() => t.classList.remove('show'), 2200);
}

// Export pour client.js (module ES ou global)
window.UI = {
  renderAll,
  renderLobby,
  renderResults,
  showToast,
};
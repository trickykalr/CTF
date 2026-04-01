// ═══════════════════════════════════════════════════════════
//  gameLogic.js — Logique pure du Blackjack (aucun DOM, aucun état global)
//  Toutes ces fonctions sont stateless : elles reçoivent des données
//  et retournent des données. Faciles à tester unitairement.
// ═══════════════════════════════════════════════════════════

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const RED_SUITS = ['♥', '♦'];

// ── Deck ────────────────────────────────────────────────────
function buildDeck(numDecks = 2) {
  const deck = [];
  for (let d = 0; d < numDecks; d++)
    for (const suit of SUITS)
      for (const rank of RANKS)
        deck.push({ rank, suit });
  return shuffle(deck);
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function drawCard(deck) {
  if (deck.length === 0) throw new Error('Deck vide');
  return deck.pop();
}

// ── Valeurs ──────────────────────────────────────────────────
function cardValue(rank) {
  if (['J', 'Q', 'K'].includes(rank)) return 10;
  if (rank === 'A') return 11;
  return parseInt(rank, 10);
}

/**
 * Calcule le total d'une main en ignorant les cartes cachées.
 * @param {Array} hand - tableau de { rank, suit, hidden? }
 * @returns {number}
 */
function handTotal(hand) {
  let total = 0;
  let aces = 0;
  for (const card of hand) {
    if (card.hidden) continue;
    total += cardValue(card.rank);
    if (card.rank === 'A') aces++;
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isBust(hand)      { return handTotal(hand) > 21; }
function isBlackjack(hand) { return handTotal(hand) === 21 && hand.length === 2; }
function isSoft17(hand) {
  // Main molle 17 : contient un as compté comme 11 + total = 17
  const total = handTotal(hand);
  if (total !== 17) return false;
  // Vérifier qu'il y a un as "souple"
  let t = 0, aces = 0;
  for (const c of hand) {
    if (c.hidden) continue;
    t += cardValue(c.rank);
    if (c.rank === 'A') aces++;
  }
  return aces > 0 && t !== 17; // l'as est compté comme 11 donc t > 17 avant réduction
}

// ── Résultats ────────────────────────────────────────────────
/**
 * Détermine le résultat d'un joueur par rapport au croupier.
 * @returns {{ result: 'win'|'lose'|'push', gain: number }}
 */
function resolvePlayer(player, dealerHand) {
  const dealerTotal = handTotal(dealerHand);
  const dealerBJ    = isBlackjack(dealerHand);
  const dealerBust  = isBust(dealerHand);

  const pTotal = handTotal(player.hand);
  const pBJ    = isBlackjack(player.hand);

  if (player.busted) {
    return { result: 'lose', gain: -player.bet };
  }
  if (pBJ && dealerBJ) {
    return { result: 'push', gain: 0 };
  }
  if (pBJ) {
    const gain = Math.floor(player.bet * 1.5);
    return { result: 'win', gain };
  }
  if (dealerBust || pTotal > dealerTotal) {
    return { result: 'win', gain: player.bet };
  }
  if (pTotal === dealerTotal) {
    return { result: 'push', gain: 0 };
  }
  return { result: 'lose', gain: -player.bet };
}

/**
 * Calcule les résultats pour tous les joueurs d'une room.
 * @param {Object} gameState - état complet du jeu côté serveur
 * @returns {Array} joueurs avec result + gain + balance mis à jour
 */
function computeResults(gameState) {
  const dealer = gameState.players[gameState.dealerIdx];
  return gameState.players.map(p => {
    if (p.role === 'dealer') return p;
    const { result, gain } = resolvePlayer(p, dealer.hand);
    const balanceDelta = gain; // la mise a déjà été déduite au deal
    return {
      ...p,
      result,
      gain,
      balance: p.balance + (result === 'lose' ? 0 : p.bet + gain)
    };
  });
}

// ── Export (Node.js) ─────────────────────────────────────────
module.exports = {
  buildDeck,
  drawCard,
  handTotal,
  isBust,
  isBlackjack,
  isSoft17,
  resolvePlayer,
  computeResults,
  RED_SUITS,
};
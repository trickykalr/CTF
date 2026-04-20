// ═══════════════════════════════════════════════════════════
//  gameLogic.js — Logique pure du Blackjack (stateless)
// ═══════════════════════════════════════════════════════════

const SUITS     = ['♠','♥','♦','♣'];
const RANKS     = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
const RED_SUITS = ['♥','♦'];

// ── Deck ─────────────────────────────────────────────────────
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

// ── Valeurs ───────────────────────────────────────────────────
function cardValue(rank) {
  if (['J','Q','K'].includes(rank)) return 10;
  if (rank === 'A') return 11;
  return parseInt(rank, 10);
}

function handTotal(hand) {
  let total = 0, aces = 0;
  for (const c of hand) {
    if (c.hidden) continue;
    total += cardValue(c.rank);
    if (c.rank === 'A') aces++;
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function isBust(hand)      { return handTotal(hand) > 21; }
function isBlackjack(hand) {
  return handTotal(hand) === 21 && hand.filter(c => !c.hidden).length === 2;
}

// ── CORRIGÉ : était `t !== 17`, doit être `t === 17` ─────────
function isSoft17(hand) {
  const total = handTotal(hand);
  if (total !== 17) return false;
  let t = 0, aces = 0;
  for (const c of hand) {
    if (c.hidden) continue;
    t += cardValue(c.rank);
    if (c.rank === 'A') aces++;
  }
  // Soft 17 = total est 17 ET il y a un As compté comme 11
  // Si t > 21 avant réduction, c'est qu'un As vaut 11 → soft
  return aces > 0 && t === 17;
}

// ── Split ─────────────────────────────────────────────────────
function canSplit(hand) {
  if (hand.length !== 2) return false;
  return cardValue(hand[0].rank) === cardValue(hand[1].rank);
}

// ── Résolution d'une main ─────────────────────────────────────
function resolveHand(hand, bet, busted, dealerHand, bjPayout = 1.5) {
  const dealerTotal = handTotal(dealerHand);
  const dealerBJ    = isBlackjack(dealerHand);
  const dealerBust  = isBust(dealerHand);
  const pTotal      = handTotal(hand);
  const pBJ         = isBlackjack(hand);

  if (busted)            return { result: 'lose', gain: -bet };
  if (pBJ && dealerBJ)   return { result: 'push', gain: 0 };
  if (pBJ)               return { result: 'win',  gain: Math.floor(bet * bjPayout) };
  if (dealerBust || pTotal > dealerTotal) return { result: 'win',  gain: bet };
  if (pTotal === dealerTotal)             return { result: 'push', gain: 0 };
  return { result: 'lose', gain: -bet };
}

// ── Résultats complets (gère le split) ───────────────────────
// CORRIGÉ : p.hasSplit → p.isSplit
function computeResults(gameState, bjPayout = 1.5) {
  const dealer = gameState.players[gameState.dealerIdx];
  return gameState.players.map(p => {
    if (p.role === 'dealer') return p;

    const main = resolveHand(p.hand, p.bet, p.busted, dealer.hand, bjPayout);

    if (!p.isSplit) {  // ← CORRIGÉ : était p.hasSplit
      return {
        ...p,
        result:  main.result,
        gain:    main.gain,
        balance: p.balance + (main.result === 'lose' ? 0 : p.bet + main.gain),
      };
    }

    const split      = resolveHand(p.splitHand, p.splitBet, p.splitBusted, dealer.hand, bjPayout);
    const totalGain  = main.gain + split.gain;
    let   newBalance = p.balance;
    if (main.result  !== 'lose') newBalance += p.bet      + main.gain;
    if (split.result !== 'lose') newBalance += p.splitBet + split.gain;

    const overallResult = totalGain > 0 ? 'win' : totalGain === 0 ? 'push' : 'lose';

    return {
      ...p,
      result:      overallResult,
      gain:        totalGain,
      balance:     newBalance,
      mainResult:  main,
      splitResult: split,
    };
  });
}

// ── Export ────────────────────────────────────────────────────
module.exports = {
  buildDeck, drawCard, handTotal,
  isBust, isBlackjack, isSoft17, canSplit,
  computeResults, RED_SUITS,
};

'use strict';

// ── Item Registry ──────────────────────────────────────────────────────
// Items are plain data objects. The engine reads behaviour from them.
// Add new weapons / boots / charms here without touching arenaEngine.
//
// Slots:
//   weapon — defines the attack pattern (getAttackPositions)
//   boots  — defines movement style (movementType)
//   charm  — registers hooks that fire on game events
//
// Hook names (fired by arenaEngine at the right moment):
//   afterMove(player, ctx)    — after a player moves and before auto-attack
//   onAttack(player, ctx)     — after a player's attack positions are resolved
//   onTurnStart(player, ctx)  — at the start of the player's turn (turn mode)
//   onHit(player, ctx)        — when this player is hit by an attack
//
// ctx shape passed to hooks:
//   ctx.fireAttack(player)    — trigger an attack from player
//   ctx.io                    — socket.io server instance
//   ctx.arena                 — live arena config object (read-only recommended)
//   ctx.registry              — playerRegistry module
//   ctx.addLog(msg, type)     — write to activity log

const ITEMS = {

  // ── Weapons ──────────────────────────────────────────────────────────

  melee: {
    slot:  'weapon',
    label: 'Melee',
    // Cross: self + 4 cardinal neighbours
    getAttackPositions(x, y, _dir, inBounds) {
      return [
        { x: x,     y: y     },
        { x: x,     y: y - 1 },
        { x: x,     y: y + 1 },
        { x: x - 1, y: y     },
        { x: x + 1, y: y     },
      ].filter(p => inBounds(p.x, p.y));
    },
  },

  area: {
    slot:  'weapon',
    label: 'Area',
    // 3×3 grid around self
    getAttackPositions(x, y, _dir, inBounds) {
      const pos = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (inBounds(x + dx, y + dy)) pos.push({ x: x + dx, y: y + dy });
      return pos;
    },
  },

  ranged: {
    slot:  'weapon',
    label: 'Ranged',
    // 4-tile line in the direction last moved
    getAttackPositions(x, y, dir, inBounds) {
      const DELTAS = {
        up:        [ 0, -1], down:      [ 0,  1],
        left:      [-1,  0], right:     [ 1,  0],
        upleft:    [-1, -1], upright:   [ 1, -1],
        downleft:  [-1,  1], downright: [ 1,  1],
      };
      const [dx, dy] = DELTAS[dir] || [0, -1];
      const pos = [];
      for (let i = 0; i <= 3; i++) {
        const nx = x + dx * i, ny = y + dy * i;
        if (inBounds(nx, ny)) pos.push({ x: nx, y: ny });
      }
      return pos;
    },
  },

  pierce: {
    slot:  'weapon',
    label: 'Pierce',
    // Full row (horizontal last move) or full column (vertical last move)
    getAttackPositions(x, y, dir, inBounds) {
      const horiz = ['left', 'right', 'upleft', 'upright', 'downleft', 'downright'].includes(dir);
      const pos = [];
      if (horiz) {
        for (let nx = 0; nx < 40; nx++) if (inBounds(nx, y)) pos.push({ x: nx, y });
      } else {
        for (let ny = 0; ny < 40; ny++) if (inBounds(x, ny)) pos.push({ x, y: ny });
      }
      return pos;
    },
  },

  // ── Boots ─────────────────────────────────────────────────────────────

  cardinal: {
    slot:         'boots',
    label:        'Cardinal',
    movementType: 'cardinal',  // 4-directional
  },

  diagonal: {
    slot:         'boots',
    label:        'Diagonal',
    movementType: 'diagonal',  // 8-directional
  },

  // ── Charms ────────────────────────────────────────────────────────────
  // Charms are the primary hook system. Each charm can define any
  // combination of hook functions. Add new charms here freely.

  // Example — uncomment to enable:
  // 'echo-charm': {
  //   slot:  'charm',
  //   label: 'Echo Charm',
  //   hooks: {
  //     // After moving, also fire an attack from the new position.
  //     afterMove(player, ctx) {
  //       ctx.fireAttack(player);
  //     },
  //   },
  // },

  // 'glass-cannon': {
  //   slot:  'charm',
  //   label: 'Glass Cannon',
  //   hooks: {
  //     // Instantly eliminated when hit.
  //     onHit(player, ctx) {
  //       ctx.addLog(`${player.name} shattered! (Glass Cannon)`, 'result-bad');
  //     },
  //   },
  // },
};

// ── Registry helpers ──────────────────────────────────────────────────

function getItem(id) {
  return ITEMS[id] || null;
}

// Compute attack hit positions for a player based on their equipped weapon.
function getAttackPositions(player, inBounds) {
  const weapon = ITEMS[player.weapon] || ITEMS.melee;
  return weapon.getAttackPositions(player.x, player.y, player.lastDir || 'up', inBounds);
}

// Resolve the movement type string for a player's equipped boots.
function getMovementType(player) {
  return ITEMS[player.boots]?.movementType || 'cardinal';
}

// Fire a named hook for every item the player has equipped.
// Silently skips slots that are empty or don't implement the hook.
function fireHooks(hookName, player, ctx) {
  for (const itemId of [player.weapon, player.boots, player.charm]) {
    ITEMS[itemId]?.hooks?.[hookName]?.(player, ctx);
  }
}

module.exports = { ITEMS, getItem, getAttackPositions, getMovementType, fireHooks };

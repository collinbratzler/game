'use strict';

// ── Enemy Engine ───────────────────────────────────────────────────────
// Pluggable AI behaviours. Add new AIs here without touching arenaEngine.
//
// Each AI is an object with a tick(enemy, ctx) method.
// ctx supplied by arenaEngine.runEnemies():
//   ctx.players       — array of live arena player records (read/write)
//   ctx.inBounds(x,y) — returns true if coordinate is inside arena
//   ctx.isWall(x,y)   — returns true if tile is a wall
//   ctx.emit(ev, data) — socket.io broadcast
//   ctx.addLog(msg, type)
//   ctx.killPlayer(socketId, name)

const ENEMY_AI = {

  // ── chaser ─────────────────────────────────────────────────────────
  // Moves one step toward the nearest player (Manhattan distance),
  // then attacks in a cross pattern.
  chaser: {
    tick(enemy, ctx) {
      const { players, inBounds, isWall, emit, killPlayer } = ctx;
      if (players.length === 0) return;

      // Find nearest player by Manhattan distance
      let nearest = null, minDist = Infinity;
      for (const p of players) {
        const d = Math.abs(p.x - enemy.x) + Math.abs(p.y - enemy.y);
        if (d < minDist) { minDist = d; nearest = p; }
      }
      if (!nearest) return;

      // Step one tile toward nearest (prefer horizontal when tied)
      const dx = nearest.x - enemy.x;
      const dy = nearest.y - enemy.y;
      let nx = enemy.x, ny = enemy.y;
      if (Math.abs(dx) >= Math.abs(dy)) nx += dx > 0 ? 1 : -1;
      else                               ny += dy > 0 ? 1 : -1;
      if (inBounds(nx, ny) && !isWall(nx, ny)) { enemy.x = nx; enemy.y = ny; }

      // Cross hit zone centred on enemy's new position
      const { x, y } = enemy;
      const hitZone = [
        { x: x,     y: y     },
        { x: x,     y: y - 1 },
        { x: x,     y: y + 1 },
        { x: x - 1, y: y     },
        { x: x + 1, y: y     },
      ].filter(h => inBounds(h.x, h.y));

      emit('arena:area-attack', { positions: hitZone, color: '#c0392b' });

      for (const p of players) {
        if (hitZone.some(h => h.x === p.x && h.y === p.y)) {
          killPlayer(p.socketId, p.name);
        }
      }
    },
  },

  // ── Add new AIs below ───────────────────────────────────────────────
  // Each entry needs only a tick(enemy, ctx) method.
  // Enemy records can carry arbitrary extra fields (e.g. patrol path,
  // cooldown counter) — arenaEngine passes them through unchanged.

  // patrol: {
  //   tick(enemy, ctx) {
  //     // Walk a fixed path stored on the enemy record.
  //     if (!enemy.path || enemy.path.length === 0) return;
  //     enemy._step = ((enemy._step || 0) + 1) % enemy.path.length;
  //     const { x, y } = enemy.path[enemy._step];
  //     if (ctx.inBounds(x, y) && !ctx.isWall(x, y)) { enemy.x = x; enemy.y = y; }
  //   },
  // },
};

// ── Run a tick for every active enemy ─────────────────────────────────
// arenaEngine calls this once per turn/interval.
function runEnemies(enemies, ctx) {
  // Deduplicate kills that happen within one tick (e.g. two enemies
  // both walking onto the same player simultaneously).
  const killed = new Set();
  const safeCtx = {
    ...ctx,
    killPlayer(socketId, name) {
      if (!killed.has(socketId)) {
        killed.add(socketId);
        ctx.killPlayer(socketId, name);
      }
    },
  };

  for (const enemy of enemies) {
    const ai = ENEMY_AI[enemy.ai || 'chaser'];
    if (ai) ai.tick(enemy, safeCtx);
  }
}

// ── Remove enemies whose position overlaps with attack positions ───────
// Returns the surviving enemies array.
// syncFn (optional) is called after any kill so the caller can update
// turn-order state (e.g. remove the enemy turn slot when enemies are gone).
function checkKillEnemies(positions, enemies, addLog, syncFn) {
  const surviving = enemies.filter(enemy => {
    if (positions.some(p => p.x === enemy.x && p.y === enemy.y)) {
      addLog('Enemy defeated!', 'result-good');
      return false;
    }
    return true;
  });
  if (surviving.length !== enemies.length && syncFn) syncFn();
  return surviving;
}

module.exports = { ENEMY_AI, runEnemies, checkKillEnemies };

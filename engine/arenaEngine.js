'use strict';

const fs   = require('fs');
const path = require('path');

const items   = require('./itemRegistry');
const enemies = require('./enemyEngine');

// ── Constants ──────────────────────────────────────────────────────────
const ENEMY_TURN_ID = '__enemy__';

// Cosmetic colours for the attack-flash effect, keyed by class.
// The item system does not override this yet — charms could in future.
const CLASS_COLORS = {
  barbarian: '#e96a6a',
  wizard:    '#4a9de0',
  healer:    '#4caf7d',
  rogue:     '#9b8afb',
};

// ── Arena state ────────────────────────────────────────────────────────
// Pure config / timing / structural data. Player positions live in
// playerRegistry — nothing here should duplicate them.
const arena = {
  // Grid as adjacency matrix: 1 = open cell, 0 = empty/impassable, 2 = wall
  // Default: 9×9 fully open
  grid: Array.from({ length: 9 }, () => Array(9).fill(1)),

  // Rules
  pvp:         false,
  enemies:     [],   // list of { id, x, y, ai, sprite }
  enemySpawns: [],   // list of { x, y, ai, sprite }

  // Turn / timer
  // 'setup' is the default: players cannot move; DM assigns positions and enemies
  // 'pause' replaces the old 'freeze'
  mode:           'setup',  // 'setup' | 'pause' | 'free' | 'turn' | 'clock'
  timerEnabled:   false,
  timerSeconds:   8,
  clockSeconds:   5,
  currentTurnIdx: 0,
  turnOrder:      [],        // socketId strings + ENEMY_TURN_ID sentinel
  // admin can assign turn order in setup phase and add enemies within turn order
  pendingActions: {},        // socketId → dir string (clock mode)
  timerInterval:  null,
  timeLeft:       0,
};

// Injected at init()
let _io, _registry, _addLog;
let _enemyIdCounter = 1;

// ── Initialisation ─────────────────────────────────────────────────────
function init(io, registry, addLog) {
  _io       = io;
  _registry = registry;
  _addLog   = addLog;
  _spawnEnemiesFromConfig();
}

// ── Boundary helpers ───────────────────────────────────────────────────
// Checks the adjacency matrix: a cell is in-bounds if it exists and is not 0.
function makeInBounds() {
  return (x, y) => {
    const row = arena.grid[y];
    return row !== undefined && row[x] !== undefined && row[x] !== 0;
  };
}

// A cell is a wall if its matrix value is 2.
function isWall(x, y) {
  const row = arena.grid[y];
  return row !== undefined && row[x] === 2;
}

// A cell is walkable only if its matrix value is 1 (open).
function canMoveTo(x, y) {
  const row = arena.grid[y];
  return row !== undefined && row[x] === 1;
}

// ── Enemy spawning ─────────────────────────────────────────────────────
function _spawnEnemiesFromConfig() {
  arena.enemies = arena.enemySpawns.map(spawn => ({
    id:     _enemyIdCounter++,
    x:      spawn.x,
    y:      spawn.y,
    ai:     spawn.ai     || 'chaser',
    sprite: spawn.sprite || 'default',
  }));
  _syncEnemyInTurnOrder();
}

function _syncEnemyInTurnOrder() {
  const shouldHaveSlot = arena.enemies.length > 0 && !arena.pvp;
  const idx = arena.turnOrder.indexOf(ENEMY_TURN_ID);
  if (shouldHaveSlot && idx === -1) {
    arena.turnOrder.push(ENEMY_TURN_ID);
  } else if (!shouldHaveSlot && idx !== -1) {
    arena.turnOrder.splice(idx, 1);
    if (arena.currentTurnIdx >= arena.turnOrder.length && arena.turnOrder.length > 0)
      arena.currentTurnIdx = 0;
  }
}

// ── Timer ──────────────────────────────────────────────────────────────
function _clearTimer() {
  if (arena.timerInterval) { clearInterval(arena.timerInterval); arena.timerInterval = null; }
}

function _startTimer() {
  _clearTimer();
  if (arena.mode === 'turn' && arena.timerEnabled && arena.turnOrder.length > 0) {
    arena.timeLeft = arena.timerSeconds;
    _io.emit('arena:turn-timer', { timeLeft: arena.timeLeft, total: arena.timerSeconds });
    arena.timerInterval = setInterval(() => {
      arena.timeLeft--;
      _io.emit('arena:turn-timer', { timeLeft: arena.timeLeft, total: arena.timerSeconds });
      if (arena.timeLeft <= 0) { _clearTimer(); _advanceTurn(); }
    }, 1000);

  } else if (arena.mode === 'clock' && arena.turnOrder.length > 0) {
    arena.timeLeft = arena.clockSeconds;
    _io.emit('arena:clock-timer', { timeLeft: arena.timeLeft, total: arena.clockSeconds });
    arena.timerInterval = setInterval(() => {
      arena.timeLeft--;
      _io.emit('arena:clock-timer', { timeLeft: arena.timeLeft, total: arena.clockSeconds });
      if (arena.timeLeft <= 0) { _clearTimer(); _resolveClockRound(); }
    }, 1000);
  }
}

// ── Turn management ────────────────────────────────────────────────────
function _isMyTurn(socketId) {
  if (arena.mode === 'setup' || arena.mode === 'pause') return false;
  if (arena.mode !== 'turn' || arena.turnOrder.length === 0) return true;
  return arena.turnOrder[arena.currentTurnIdx % arena.turnOrder.length] === socketId;
}

function _advanceTurn() {
  if (arena.turnOrder.length === 0) return;
  _clearTimer();
  arena.currentTurnIdx = (arena.currentTurnIdx + 1) % arena.turnOrder.length;
  _io.emit('arena:state', getSnapshot());
  const current = arena.turnOrder[arena.currentTurnIdx];
  if (current === ENEMY_TURN_ID) _startEnemyTurn();
  else _startTimer();
}

// Enemy "turn": short delay then act, then hand off to next player.
function _startEnemyTurn() {
  _clearTimer();
  let elapsed = 0;
  arena.timerInterval = setInterval(() => {
    elapsed += 100;
    if (elapsed >= 700) {
      _clearTimer();
      _runEnemies();
      _io.emit('arena:state', getSnapshot());
      if (arena.turnOrder.length > 0) {
        arena.currentTurnIdx = (arena.currentTurnIdx + 1) % arena.turnOrder.length;
        _io.emit('arena:state', getSnapshot());
        _startTimer();
      }
    }
  }, 100);
}

// Used by clock mode: 700ms delay, enemies act, then callback.
function _enemyDelayThen(cb) {
  let elapsed = 0;
  const interval = setInterval(() => {
    elapsed += 100;
    if (elapsed >= 700) { clearInterval(interval); _runEnemies(); cb(); }
  }, 100);
}

// ── Enemy execution ────────────────────────────────────────────────────
function _runEnemies() {
  const ctx = {
    players:    _registry.getArenaPlayers(),
    inBounds:   makeInBounds(),
    isWall,
    emit:       (ev, data) => _io.emit(ev, data),
    addLog:     _addLog,
    killPlayer: _killPlayer,
  };
  enemies.runEnemies(arena.enemies, ctx);
}

// ── Clock round ────────────────────────────────────────────────────────
function _resolveClockRound() {
  const DIRS = {
    up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
    upleft: [-1, -1], upright: [1, -1], downleft: [-1, 1], downright: [1, 1],
  };

  // 1. Move all players simultaneously
  for (const [sid, action] of Object.entries(arena.pendingActions)) {
    if (sid === ENEMY_TURN_ID) continue;
    const p = _registry.get(sid);
    if (!p || !p.inArena) continue;
    const delta = DIRS[action];
    if (delta) {
      const [dx, dy] = delta;
      const nx = p.x + dx, ny = p.y + dy;
      if (canMoveTo(nx, ny)) _registry.update(sid, { x: nx, y: ny, lastDir: action });
      else                   _registry.update(sid, { lastDir: action });
    }
  }

  // 2. Fire all attacks simultaneously (re-read positions after moves)
  for (const p of _registry.getArenaPlayers()) {
    _fireAttack(p);
  }

  // 3. Enemy acts (if applicable), then reset pending and restart clock
  const afterClock = () => {
    arena.pendingActions = {};
    for (const sid of arena.turnOrder) {
      if (sid !== ENEMY_TURN_ID) arena.pendingActions[sid] = 'stay';
    }
    _io.emit('arena:clock-round-end');
    _io.emit('arena:state', getSnapshot());
    _startTimer();
  };

  if (arena.enemies.length > 0 && !arena.pvp) {
    _enemyDelayThen(afterClock);
  } else {
    afterClock();
  }
}

// ── Attack ─────────────────────────────────────────────────────────────
function _fireAttack(player) {
  const inBounds  = makeInBounds();
  const color     = CLASS_COLORS[player.playerClass] || '#e96a6a';
  const positions = items.getAttackPositions(player, inBounds);

  _io.emit('arena:area-attack', { positions, color });

  // Fire onAttack hooks (charms may add side-effects here)
  items.fireHooks('onAttack', player, _makeHookCtx(player));

  // PvP: eliminate players caught in blast
  if (arena.pvp) {
    for (const target of _registry.getArenaPlayers()) {
      if (target.socketId !== player.socketId && positions.some(h => h.x === target.x && h.y === target.y))
        _killPlayer(target.socketId, target.name);
    }
  }

  // Enemies: remove those caught in blast
  if (arena.enemies.length > 0) {
    arena.enemies = enemies.checkKillEnemies(positions, arena.enemies, _addLog, _syncEnemyInTurnOrder);
  }
}

// Build the context object passed to item hooks.
function _makeHookCtx(player) {
  return {
    fireAttack: (p) => _fireAttack(p),
    io:         _io,
    arena,
    registry:   _registry,
    addLog:     _addLog,
  };
}

// ── Kill player ────────────────────────────────────────────────────────
function _killPlayer(socketId, name) {
  const idx = arena.turnOrder.indexOf(socketId);
  if (idx !== -1) {
    arena.turnOrder.splice(idx, 1);
    if (arena.turnOrder.length > 0 && arena.currentTurnIdx >= arena.turnOrder.length)
      arena.currentTurnIdx = 0;
  }
  delete arena.pendingActions[socketId];
  _registry.update(socketId, { inArena: false });
  _io.to(socketId).emit('player:load-module', 'dungeon-dead');
  _addLog(`☠ ${name} eliminated`, 'result-bad');
}

// ── Snapshot ───────────────────────────────────────────────────────────
function getSnapshot() {
  const len    = arena.turnOrder.length;
  const curSid = arena.mode === 'turn' && len > 0
    ? arena.turnOrder[arena.currentTurnIdx % len] : null;
  const curPlayer = (curSid && curSid !== ENEMY_TURN_ID) ? _registry.get(curSid) : null;
  const currentTurn = curSid === ENEMY_TURN_ID ? 'Enemy' : (curPlayer ? curPlayer.name : null);

  return {
    grid:           arena.grid,
    pvp:            arena.pvp,
    enemies:        arena.enemies,
    enemySpawns:    arena.enemySpawns,
    players:        _registry.getArenaPlayers().map(_registry.toArenaShape),
    mode:           arena.mode,
    timerEnabled:   arena.timerEnabled,
    timerSeconds:   arena.timerSeconds,
    clockSeconds:   arena.clockSeconds,
    timeLeft:       arena.timeLeft,
    currentTurn,
    pendingActions: arena.mode === 'clock' ? arena.pendingActions : {},
  };
}

// ── Socket event handlers ──────────────────────────────────────────────
// Called directly from server.js — keep logic here, not in the handlers.

function handleJoin(socketId, name) {
  const p = _registry.get(socketId);
  if (!p) return;

  const noPlayersBefore = _registry.getArenaPlayers().length === 0;
  const rows    = arena.grid.length;
  const cols    = arena.grid[0] ? arena.grid[0].length : 0;
  const centerX = Math.floor(cols / 2);
  const centerY = Math.floor(rows / 2);
  _registry.update(socketId, { inArena: true, lastDir: 'up', x: centerX, y: centerY });

  if (!arena.turnOrder.includes(socketId)) {
    const enemyIdx = arena.turnOrder.indexOf(ENEMY_TURN_ID);
    if (enemyIdx !== -1) arena.turnOrder.splice(enemyIdx, 0, socketId);
    else arena.turnOrder.push(socketId);
  }
  arena.pendingActions[socketId] = 'stay';

  const updated = _registry.get(socketId);
  _io.to(socketId).emit('arena:joined', {
    name:         updated.name,
    x:            updated.x,
    y:            updated.y,
    colorIndex:   updated.colorIndex,
    playerClass:  updated.playerClass,
    movementType: items.getMovementType(updated),  // legacy field expected by arena-player.html
    attackType:   updated.weapon,                  // legacy field expected by arena-player.html
  });

  _io.emit('arena:state', getSnapshot());
  if (noPlayersBefore && arena.mode !== 'free' && arena.mode !== 'pause' && arena.mode !== 'setup') _startTimer();
}

function handleMove(socketId, dir) {
  const p = _registry.get(socketId);
  if (!p || !p.inArena || arena.mode === 'setup' || arena.mode === 'pause') return;

  const DIRS = {
    up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0],
    upleft: [-1, -1], upright: [1, -1], downleft: [-1, 1], downright: [1, 1],
  };
  if (!DIRS[dir]) return;

  // Clock mode: queue the action, don't resolve yet
  if (arena.mode === 'clock') {
    arena.pendingActions[socketId] = dir;
    _io.to(socketId).emit('arena:action-selected', dir);
    return;
  }

  if (!_isMyTurn(socketId)) return;

  const [dx, dy] = DIRS[dir];
  const nx = p.x + dx, ny = p.y + dy;
  if (canMoveTo(nx, ny)) _registry.update(socketId, { x: nx, y: ny, lastDir: dir });
  else                   _registry.update(socketId, { lastDir: dir });

  const updated = _registry.get(socketId);

  // afterMove hooks fire before the auto-attack (charms can add effects here)
  items.fireHooks('afterMove', updated, _makeHookCtx(updated));

  _fireAttack(updated);

  if (arena.mode === 'turn') _advanceTurn();
  else _io.emit('arena:state', getSnapshot());
}

function handleAttack(socketId) {
  const p = _registry.get(socketId);
  if (!p || !p.inArena || arena.mode === 'setup' || arena.mode === 'pause') return;

  if (arena.mode === 'clock') {
    arena.pendingActions[socketId] = 'stay';
    _io.to(socketId).emit('arena:action-selected', 'stay');
    return;
  }

  if (!_isMyTurn(socketId)) return;
  _fireAttack(p);
  if (arena.mode === 'turn') _advanceTurn();
  else _io.emit('arena:state', getSnapshot());
}

function handleDisconnect(socketId) {
  const p = _registry.get(socketId);
  if (!p || !p.inArena) return;

  delete arena.pendingActions[socketId];
  const idx = arena.turnOrder.indexOf(socketId);
  if (idx !== -1) {
    const wasMyTurn = _isMyTurn(socketId) && arena.mode === 'turn';
    if (wasMyTurn) _clearTimer();
    arena.turnOrder.splice(idx, 1);
    if (arena.turnOrder.length > 0 && arena.currentTurnIdx >= arena.turnOrder.length)
      arena.currentTurnIdx = 0;
    if (arena.mode === 'turn' && arena.turnOrder.length > 0) {
      const next = arena.turnOrder[arena.currentTurnIdx % arena.turnOrder.length];
      if (next === ENEMY_TURN_ID) _startEnemyTurn();
      else _startTimer();
    }
  }
  _registry.update(socketId, { inArena: false });
  _io.emit('arena:state', getSnapshot());
}

function handleReset(currentModule) {
  _clearTimer();
  for (const p of _registry.getArenaPlayers()) {
    _registry.update(p.socketId, { inArena: false });
  }
  arena.turnOrder      = [];
  arena.currentTurnIdx = 0;
  arena.pendingActions = {};
  _spawnEnemiesFromConfig();
  for (const p of _registry.getAll()) {
    _io.to(p.socketId).emit('player:load-module', currentModule);
  }
  _io.emit('arena:state', getSnapshot());
  _addLog('Arena reset', 'action');
}

function handleConfig({ grid, pvp }) {
  _clearTimer();
  if (Array.isArray(grid)) arena.grid = grid;
  if (pvp !== undefined) arena.pvp = !!pvp;
  const inBounds = makeInBounds();
  const rows = arena.grid.length;
  const cols = arena.grid[0] ? arena.grid[0].length : 0;
  for (const p of _registry.getArenaPlayers()) {
    if (!inBounds(p.x, p.y))
      _registry.update(p.socketId, { x: Math.floor(cols / 2), y: Math.floor(rows / 2) });
  }
  _io.emit('arena:state', getSnapshot());
}

function handleMode(mode) {
  if (!['setup', 'pause', 'free', 'turn', 'clock'].includes(mode)) return;
  _clearTimer();
  arena.mode           = mode;
  arena.currentTurnIdx = 0;
  arena.pendingActions = {};
  if (mode === 'clock') {
    for (const sid of arena.turnOrder) {
      if (sid !== ENEMY_TURN_ID) arena.pendingActions[sid] = 'stay';
    }
  }
  _io.emit('arena:turn-timer',  { timeLeft: 0, total: arena.timerSeconds });
  _io.emit('arena:clock-timer', { timeLeft: 0, total: arena.clockSeconds });
  _io.emit('arena:state', getSnapshot());
  _startTimer();
}

function handleTimerToggle() {
  arena.timerEnabled = !arena.timerEnabled;
  _clearTimer();
  _startTimer();
  if (!arena.timerEnabled) _io.emit('arena:turn-timer', { timeLeft: 0, total: arena.timerSeconds });
  _io.emit('arena:state', getSnapshot());
}

function handleTimerSet({ turnSecs, clockSecs }) {
  if (turnSecs  != null) arena.timerSeconds = Math.max(3, Math.min(120, Math.floor(turnSecs)));
  if (clockSecs != null) arena.clockSeconds = Math.max(3, Math.min(120, Math.floor(clockSecs)));
  _clearTimer();
  _startTimer();
  _io.emit('arena:state', getSnapshot());
}

function handleSetEnemySpawns(spawns) {
  if (!Array.isArray(spawns)) return;
  arena.enemySpawns = spawns.map(s => ({
    x:      Math.floor(s.x),
    y:      Math.floor(s.y),
    ai:     s.ai     || 'chaser',
    sprite: s.sprite || 'default',
  }));
  _spawnEnemiesFromConfig();
  _io.emit('arena:state', getSnapshot());
  _addLog(`Enemy spawns updated: ${arena.enemySpawns.length}`, 'info');
}

function handleLoadLevel(levelId) {
  const levelPath = path.join(__dirname, '../levels', `${levelId}.json`);
  if (!fs.existsSync(levelPath)) return;
  try {
    const cfg = JSON.parse(fs.readFileSync(levelPath, 'utf8'));
    _clearTimer();
    if (Array.isArray(cfg.grid)) arena.grid = cfg.grid;
    if (cfg.pvp !== undefined) arena.pvp = !!cfg.pvp;
    if (Array.isArray(cfg.enemySpawns)) {
      arena.enemySpawns = cfg.enemySpawns;
      _spawnEnemiesFromConfig();
    }
    _io.emit('arena:state', getSnapshot());
    _addLog(`Level loaded: ${cfg.name || levelId}`, 'action');
  } catch (_) { /* malformed JSON — silently ignore */ }
}

function handleSetClass(socketId, playerClass) {
  const p = _registry.get(socketId);
  if (!p) return;
  _registry.update(socketId, { playerClass });
  _io.to(socketId).emit('arena:class-update', playerClass);
  _addLog(`Class override: ${p.name} → ${playerClass}`, 'action');
}

// ── Free-mode enemy auto-tick ──────────────────────────────────────────
function startFreeModeInterval() {
  setInterval(() => {
    if (arena.mode === 'free' && arena.enemies.length > 0 &&
        _registry.getArenaPlayers().length > 0) {
      _runEnemies();
      _io.emit('arena:state', getSnapshot());
    }
  }, 1500);
}

module.exports = {
  init,
  getSnapshot,
  handleJoin,
  handleMove,
  handleAttack,
  handleDisconnect,
  handleReset,
  handleConfig,
  handleMode,
  handleTimerToggle,
  handleTimerSet,
  handleSetEnemySpawns,
  handleLoadLevel,
  handleSetClass,
  startFreeModeInterval,
  arena,  // exposed read-only for server.js state snapshot
};

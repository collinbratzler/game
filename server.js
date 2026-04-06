const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const QRCode  = require('qrcode');
const os      = require('os');
const fs      = require('fs');
const path    = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT         = 3000;
const ENEMY_TURN_ID = '__enemy__';  // sentinel in turnOrder for the enemy turn slot

// ── Class behaviors — used for class color on attack flash ────────────
const CLASS_BEHAVIORS = {
  barbarian: { color: '#e96a6a' },
  wizard:    { color: '#4a9de0' },
  healer:    { color: '#4caf7d' },
  rogue:     { color: '#9b8afb' },
};

// ── Attack behaviors — chosen independently by the player ─────────────
const ATTACK_BEHAVIORS = {
  // Cross pattern: self + 4 cardinal neighbours
  melee: {
    getPositions(x, y, dir, inBounds) {
      return [{ x, y }, { x, y: y-1 }, { x, y: y+1 }, { x: x-1, y }, { x: x+1, y }]
        .filter(p => inBounds(p.x, p.y));
    },
  },
  // 3×3 area around self
  area: {
    getPositions(x, y, dir, inBounds) {
      const pos = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++)
          if (inBounds(x + dx, y + dy)) pos.push({ x: x + dx, y: y + dy });
      return pos;
    },
  },
  // 4-tile line in the direction the player last moved
  ranged: {
    getPositions(x, y, dir, inBounds) {
      const DELTAS = {
        up:[0,-1], down:[0,1], left:[-1,0], right:[1,0],
        upleft:[-1,-1], upright:[1,-1], downleft:[-1,1], downright:[1,1],
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
  // Full row (horizontal last move) or column (vertical last move)
  pierce: {
    getPositions(x, y, dir, inBounds) {
      const horiz = ['left','right','upleft','upright','downleft','downright'].includes(dir);
      const pos = [];
      if (horiz) { for (let nx = 0; nx < 40; nx++) if (inBounds(nx, y)) pos.push({ x: nx, y }); }
      else        { for (let ny = 0; ny < 40; ny++) if (inBounds(x, ny)) pos.push({ x, y: ny }); }
      return pos;
    },
  },
};

// ── Display routing ───────────────────────────────────────────────────
const DISPLAY_MAP = {
  'waiting':          'waiting-display',
  'character-select': 'character-select-display',
  'arena':            'arena-display',
  'chat':             'chat-display',
};
function toDisplayModule(id) { return DISPLAY_MAP[id] || id; }

// ── Global state ──────────────────────────────────────────────────────
const state = {
  players:        {},   // socketId → { name, socketId, playerClass }
  currentModule:  'waiting',
  currentDisplay: toDisplayModule('waiting'),
  chatHistory:    [],
  activityLog:    [],
};

// ── Arena state ────────────────────────────────────────────────────────
const arena = {
  // Shape config
  shape:    'rect',   // 'rect' | 'circle'
  width:    10,
  height:   8,
  radius:   5,        // circle only
  gridSize: 11,       // circle only: 2*radius+1

  // Rules
  pvp:         false,   // players can kill each other
  hasEnemy:    true,    // NPC enemies enabled (master toggle)
  enemySpawns: [{ x: 9, y: 7 }],  // spawn positions (permanent config)
  enemies:     [],  // active enemies — populated by spawnEnemiesFromConfig() at startup
  walls:       [],      // [{ x, y }] impassable tiles

  // Players
  players:  {},       // socketId → { name, x, y, colorIndex }

  // Mode
  mode:          'freeze',  // 'freeze' | 'free' | 'turn' | 'clock'
  timerEnabled:  false,
  timerSeconds:  8,
  clockSeconds:  5,
  currentTurnIdx: 0,
  turnOrder:     [],
  pendingActions: {},
  timerInterval:  null,
  timeLeft:       0,
};
let arenaColorCounter = 0;

// ── Boundary helpers ───────────────────────────────────────────────────
function makeInBounds() {
  if (arena.shape === 'circle') {
    const c = Math.floor(arena.gridSize / 2);
    const r = arena.radius;
    return (x, y) => (x - c) * (x - c) + (y - c) * (y - c) <= r * r;
  }
  return (x, y) => x >= 0 && x < arena.width && y >= 0 && y < arena.height;
}
function isWall(x, y) { return arena.walls.some(w => w.x === x && w.y === y); }
function canMoveTo(x, y) { return makeInBounds()(x, y) && !isWall(x, y); }

// ── Spawn helpers ──────────────────────────────────────────────────────
function recalcCircle() {
  const n = Math.max(1, Object.keys(arena.players).length);
  arena.radius   = Math.max(5, 4 + Math.ceil(n / 2));
  arena.gridSize = 2 * arena.radius + 1;
}

function spawnPosition(index, total) {
  if (arena.shape === 'circle') {
    const c = Math.floor(arena.gridSize / 2);
    const r = Math.round(arena.radius * 0.65);
    const angle = (2 * Math.PI * index / Math.max(total, 1)) - Math.PI / 2;
    return { x: c + Math.round(r * Math.cos(angle)), y: c + Math.round(r * Math.sin(angle)) };
  }
  const offsets = [
    { dx: 0, dy: 0 }, { dx: 2, dy: 0 }, { dx: -2, dy: 0 },
    { dx: 0, dy: 2 }, { dx: 0, dy: -2 }, { dx: 2, dy: 2 },
    { dx: -2, dy: -2 }, { dx: 2, dy: -2 }, { dx: -2, dy: 2 },
  ];
  const o = offsets[index % offsets.length];
  return {
    x: Math.max(0, Math.min(arena.width  - 1, Math.floor(arena.width  / 2) + o.dx)),
    y: Math.max(0, Math.min(arena.height - 1, Math.floor(arena.height / 2) + o.dy)),
  };
}

function respawnAll() {
  const entries = Object.values(arena.players);
  entries.forEach((p, i) => {
    const pos = spawnPosition(i, entries.length);
    p.x = pos.x; p.y = pos.y;
  });
}

// ── Timer ──────────────────────────────────────────────────────────────
function clearArenaTimer() {
  if (arena.timerInterval) { clearInterval(arena.timerInterval); arena.timerInterval = null; }
}

function startArenaTimer() {
  clearArenaTimer();
  if (arena.mode === 'turn' && arena.timerEnabled && arena.turnOrder.length > 0) {
    arena.timeLeft = arena.timerSeconds;
    io.emit('arena:turn-timer', { timeLeft: arena.timeLeft, total: arena.timerSeconds });
    arena.timerInterval = setInterval(() => {
      arena.timeLeft--;
      io.emit('arena:turn-timer', { timeLeft: arena.timeLeft, total: arena.timerSeconds });
      if (arena.timeLeft <= 0) { clearArenaTimer(); advanceTurn(); }
    }, 1000);
  } else if (arena.mode === 'clock' && arena.turnOrder.length > 0) {
    arena.timeLeft = arena.clockSeconds;
    io.emit('arena:clock-timer', { timeLeft: arena.timeLeft, total: arena.clockSeconds });
    arena.timerInterval = setInterval(() => {
      arena.timeLeft--;
      io.emit('arena:clock-timer', { timeLeft: arena.timeLeft, total: arena.clockSeconds });
      if (arena.timeLeft <= 0) { clearArenaTimer(); resolveClockRound(); }
    }, 1000);
  }
}

// ── Turn management ────────────────────────────────────────────────────
function isMyTurn(socketId) {
  if (arena.mode === 'freeze') return false;
  if (arena.mode !== 'turn' || arena.turnOrder.length === 0) return true;
  return arena.turnOrder[arena.currentTurnIdx % arena.turnOrder.length] === socketId;
}

// Keep enemy slot in sync with arena config
function syncEnemyInTurnOrder() {
  const shouldHaveSlot = arena.hasEnemy && arena.enemies.length > 0 && !arena.pvp;
  const idx = arena.turnOrder.indexOf(ENEMY_TURN_ID);
  if (shouldHaveSlot && idx === -1) {
    arena.turnOrder.push(ENEMY_TURN_ID);
  } else if (!shouldHaveSlot && idx !== -1) {
    arena.turnOrder.splice(idx, 1);
    if (arena.currentTurnIdx >= arena.turnOrder.length && arena.turnOrder.length > 0)
      arena.currentTurnIdx = 0;
  }
}

// Enemy "turn": wait 700ms via interval, then act, then advance
function startEnemyTurn() {
  clearArenaTimer();
  let elapsed = 0;
  arena.timerInterval = setInterval(() => {
    elapsed += 100;
    if (elapsed >= 700) {
      clearArenaTimer();
      moveAndAttackEnemies();
      io.emit('arena:state', getArenaSnapshot());
      // Advance past enemy slot to next player
      if (arena.turnOrder.length > 0) {
        arena.currentTurnIdx = (arena.currentTurnIdx + 1) % arena.turnOrder.length;
        io.emit('arena:state', getArenaSnapshot());
        startArenaTimer();
      }
    }
  }, 100);
}

// Used by clock mode and free mode (not turn mode) — 700ms delay then act then callback
function executeEnemyActionThenCallback(cb) {
  let elapsed = 0;
  const interval = setInterval(() => {
    elapsed += 100;
    if (elapsed >= 700) {
      clearInterval(interval);
      moveAndAttackEnemies();
      cb();
    }
  }, 100);
}

function advanceTurn() {
  if (arena.turnOrder.length === 0) return;
  clearArenaTimer();
  arena.currentTurnIdx = (arena.currentTurnIdx + 1) % arena.turnOrder.length;
  io.emit('arena:state', getArenaSnapshot());

  const current = arena.turnOrder[arena.currentTurnIdx];
  if (current === ENEMY_TURN_ID) {
    startEnemyTurn();
  } else {
    startArenaTimer();
  }
}

function fireAttack(socketId, isStay) {
  const p = arena.players[socketId];
  if (!p) return;
  const sp         = Object.values(state.players).find(s => s.name === p.name);
  const cls        = sp?.playerClass  || 'barbarian';
  const attackType = sp?.attackType   || 'melee';
  const classColor = CLASS_BEHAVIORS[cls]?.color || '#e96a6a';
  const behavior   = ATTACK_BEHAVIORS[attackType] || ATTACK_BEHAVIORS.melee;

  const positions = behavior.getPositions(p.x, p.y, p.lastDir || 'up', makeInBounds());
  io.emit('arena:area-attack', { positions, color: classColor });

  if (arena.pvp) {
    const toKill = [];
    for (const [sid, target] of Object.entries(arena.players)) {
      if (sid === socketId) continue;
      if (positions.some(h => h.x === target.x && h.y === target.y))
        toKill.push({ sid, name: target.name });
    }
    for (const { sid, name } of toKill) killPlayer(sid, name);
  }
  if (arena.hasEnemy && arena.enemies.length > 0) checkKillEnemies(positions);
}

// ── Clock round ────────────────────────────────────────────────────────
function resolveClockRound() {
  const inBounds = makeInBounds();
  const DIRS = {
    up:[0,-1], down:[0,1], left:[-1,0], right:[1,0],
    upleft:[-1,-1], upright:[1,-1], downleft:[-1,1], downright:[1,1],
  };
  // 1. Move all players simultaneously
  for (const [sid, action] of Object.entries(arena.pendingActions)) {
    if (sid === ENEMY_TURN_ID) continue;
    const p = arena.players[sid];
    if (!p) continue;
    const delta = DIRS[action];
    if (delta) {
      const [dx, dy] = delta;
      const nx = p.x + dx, ny = p.y + dy;
      if (inBounds(nx, ny) && !isWall(nx, ny)) { p.x = nx; p.y = ny; }
      p.lastDir = action;
    }
  }
  // 2. Fire all attacks simultaneously
  for (const sid of Object.keys(arena.players)) {
    const action = arena.pendingActions[sid] || 'stay';
    fireAttack(sid, action === 'stay');
  }
  // 3. Enemy acts (if applicable), then reset pending actions and restart clock
  const afterClock = () => {
    arena.pendingActions = {};
    for (const sid of arena.turnOrder) {
      if (sid !== ENEMY_TURN_ID) arena.pendingActions[sid] = 'stay';
    }
    io.emit('arena:clock-round-end');
    io.emit('arena:state', getArenaSnapshot());
    startArenaTimer();
  };
  if (arena.hasEnemy && arena.enemies.length > 0 && !arena.pvp) {
    executeEnemyActionThenCallback(afterClock);
  } else {
    afterClock();
  }
}

// ── Enemy AI ───────────────────────────────────────────────────────────
let enemyIdCounter = 1;

function spawnEnemiesFromConfig() {
  arena.enemies = arena.enemySpawns.map(() => ({
    id: enemyIdCounter++, x: 0, y: 0,
  }));
  // Set actual positions
  arena.enemies.forEach((e, i) => {
    e.x = arena.enemySpawns[i].x;
    e.y = arena.enemySpawns[i].y;
  });
  syncEnemyInTurnOrder();
}

function moveAndAttackEnemies() {
  const players = Object.values(arena.players);
  const inBounds = makeInBounds();
  const toKillPlayers = [];

  for (const enemy of arena.enemies) {
    if (players.length === 0) break;

    // Find nearest player (Manhattan distance)
    let nearest = null, minDist = Infinity;
    for (const p of players) {
      const d = Math.abs(p.x - enemy.x) + Math.abs(p.y - enemy.y);
      if (d < minDist) { minDist = d; nearest = p; }
    }
    if (!nearest) continue;

    // Move one step toward nearest
    const dx = nearest.x - enemy.x;
    const dy = nearest.y - enemy.y;
    let nx = enemy.x, ny = enemy.y;
    if (Math.abs(dx) >= Math.abs(dy)) nx += dx > 0 ? 1 : -1;
    else                               ny += dy > 0 ? 1 : -1;
    if (inBounds(nx, ny) && !isWall(nx, ny)) { enemy.x = nx; enemy.y = ny; }

    // Cross hit zone attack
    const { x, y } = enemy;
    const hitZone = [{ x, y }, { x, y: y-1 }, { x, y: y+1 }, { x: x-1, y }, { x: x+1, y }]
      .filter(h => inBounds(h.x, h.y));
    io.emit('arena:area-attack', { positions: hitZone, color: '#c0392b' });

    for (const [sid, p] of Object.entries(arena.players)) {
      if (hitZone.some(h => h.x === p.x && h.y === p.y))
        toKillPlayers.push({ sid, name: p.name });
    }
  }

  // Kill players after all enemies have acted (avoid modifying mid-loop)
  const killed = new Set();
  for (const { sid, name } of toKillPlayers) {
    if (!killed.has(sid)) { killed.add(sid); killPlayer(sid, name); }
  }
}

function checkKillEnemies(positions) {
  arena.enemies = arena.enemies.filter(enemy => {
    if (positions.some(p => p.x === enemy.x && p.y === enemy.y)) {
      addLog('Enemy defeated!', 'result-good');
      return false;
    }
    return true;
  });
  syncEnemyInTurnOrder();
}

function killPlayer(socketId, name) {
  const idx = arena.turnOrder.indexOf(socketId);
  if (idx !== -1) {
    arena.turnOrder.splice(idx, 1);
    if (arena.turnOrder.length > 0 && arena.currentTurnIdx >= arena.turnOrder.length)
      arena.currentTurnIdx = 0;
  }
  delete arena.players[socketId];
  delete arena.pendingActions[socketId];
  const sp = Object.values(state.players).find(p => p.name === name);
  if (sp) io.to(sp.socketId).emit('player:load-module', 'dungeon-dead');
  addLog(`☠ ${name} eliminated`, 'result-bad');
}

// ── Snapshots ──────────────────────────────────────────────────────────
function getArenaSnapshot() {
  const activeLen = arena.turnOrder.length;
  const curSid = arena.mode === 'turn' && activeLen > 0
    ? arena.turnOrder[arena.currentTurnIdx % activeLen] : null;
  const curPlayer = (curSid && curSid !== ENEMY_TURN_ID) ? arena.players[curSid] : null;
  const currentTurn = curSid === ENEMY_TURN_ID ? 'Enemy'
    : (curPlayer ? curPlayer.name : null);
  return {
    shape:        arena.shape,
    width:        arena.width,
    height:       arena.height,
    radius:       arena.radius,
    gridSize:     arena.gridSize,
    pvp:          arena.pvp,
    hasEnemy:     arena.hasEnemy,
    enemies:      arena.enemies,
    enemySpawns:  arena.enemySpawns,
    walls:        arena.walls,
    players:      Object.values(arena.players),
    mode:         arena.mode,
    timerEnabled: arena.timerEnabled,
    timerSeconds: arena.timerSeconds,
    clockSeconds: arena.clockSeconds,
    timeLeft:     arena.timeLeft,
    currentTurn:  currentTurn,
    pendingActions: arena.mode === 'clock' ? arena.pendingActions : {},
  };
}

function getStateSnapshot() {
  return {
    players: Object.values(state.players).map(p => ({
      name:          p.name,
      socketId:      p.socketId,
      playerClass:   p.playerClass   || 'barbarian',
      movementType:  p.movementType  || 'cardinal',
      attackType:    p.attackType    || 'melee',
      colorIndex:    p.colorIndex    ?? null,
      charSelectDone: p.charSelectDone || false,
    })),
    currentModule:  state.currentModule,
    currentDisplay: state.currentDisplay,
    arena: {
      shape:    arena.shape,
      width:    arena.width,
      height:   arena.height,
      pvp:      arena.pvp,
      hasEnemy: arena.hasEnemy,
    },
  };
}

// ── HTTP routes ────────────────────────────────────────────────────────
app.use(express.static('public'));

function getLocalIP() {
  const candidates = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets) {
      if (net.family !== 'IPv4' || net.internal) continue;
      candidates.push(net.address);
    }
  }
  return candidates.find(ip => /^192\.168\./.test(ip))
      || candidates.find(ip => /^10\./.test(ip))
      || candidates.find(ip => /^172\.(1[6-9]|2\d|3[01])\./.test(ip))
      || candidates[0] || 'localhost';
}

app.get('/api/join-url', (req, res) => {
  res.json({ url: `http://${getLocalIP()}:${PORT}/player.html` });
});

app.get('/api/qr.svg', async (req, res) => {
  const url = `http://${getLocalIP()}:${PORT}/player.html`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#1a1a1a', light: '#f7f6f3' } });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

app.get('/api/levels', (req, res) => {
  const dir = path.join(__dirname, 'levels');
  if (!fs.existsSync(dir)) { res.json([]); return; }
  const levels = fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return { id: f.replace('.json', ''), name: data.name || f };
      } catch { return null; }
    }).filter(Boolean);
  res.json(levels);
});

function addLog(message, type = 'info') {
  const entry = { ts: Date.now(), message, type };
  state.activityLog.push(entry);
  if (state.activityLog.length > 200) state.activityLog.shift();
  io.emit('host:log-update', state.activityLog);
}

// ── Socket.io ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── Host ────────────────────────────────────────────────────────────
  socket.on('host:request-state', () => {
    socket.emit('host:state-update', getStateSnapshot());
    socket.emit('host:log-update', state.activityLog);
    socket.emit('arena:state', getArenaSnapshot());
  });

  socket.on('host:push', (moduleId) => {
    const displayId = toDisplayModule(moduleId);
    state.currentModule  = moduleId;
    state.currentDisplay = displayId;
    io.emit('player:load-module',  moduleId);
    io.emit('display:load-module', displayId);
    io.emit('host:state-update', getStateSnapshot());
    addLog(`→ ${moduleId}`, 'action');
  });

  socket.on('host:send-minigame', ({ socketId, minigame }) => {
    const player = state.players[socketId];
    if (!player) return;
    io.to(socketId).emit('player:load-module', minigame);
    addLog(`Sent "${minigame}" → ${player.name}`, 'minigame');
  });

  socket.on('host:send-minigame-all', ({ minigame }) => {
    const players = Object.values(state.players);
    if (players.length === 0) return;
    players.forEach(({ socketId }) => io.to(socketId).emit('player:load-module', minigame));
    addLog(`Sent "${minigame}" → all (${players.length})`, 'minigame');
  });

  socket.on('host:set-class', ({ socketId, playerClass }) => {
    if (!state.players[socketId]) return;
    state.players[socketId].playerClass = playerClass;
    const name = state.players[socketId].name;
    const arenaEntry = Object.entries(arena.players).find(([, p]) => p.name === name);
    if (arenaEntry) io.to(arenaEntry[0]).emit('arena:class-update', playerClass);
    io.emit('host:state-update', getStateSnapshot());
    addLog(`Class override: ${name} → ${playerClass}`, 'action');
  });

  // Arena config: shape, size, pvp, enemy toggle
  socket.on('host:arena-config', ({ shape, width, height, pvp, hasEnemy }) => {
    clearArenaTimer();
    if (shape && ['rect', 'circle'].includes(shape)) arena.shape = shape;
    if (width  != null) arena.width  = Math.max(2, Math.min(30, Math.floor(width)));
    if (height != null) arena.height = Math.max(2, Math.min(30, Math.floor(height)));
    if (pvp      !== undefined) arena.pvp      = !!pvp;
    if (hasEnemy !== undefined) {
      arena.hasEnemy = !!hasEnemy;
      syncEnemyInTurnOrder();
    }
    if (arena.shape === 'circle') recalcCircle();
    // Clamp out-of-bounds players
    const inBounds = makeInBounds();
    for (const p of Object.values(arena.players)) {
      if (!inBounds(p.x, p.y)) { p.x = Math.floor(arena.width / 2); p.y = Math.floor(arena.height / 2); }
    }
    io.emit('arena:state', getArenaSnapshot());
    io.emit('host:state-update', getStateSnapshot());
    addLog(`Arena: ${arena.shape} ${arena.width}×${arena.height} pvp=${arena.pvp} enemy=${arena.hasEnemy}`, 'info');
  });

  socket.on('host:arena-mode', (mode) => {
    if (!['freeze', 'free', 'turn', 'clock'].includes(mode)) return;
    clearArenaTimer();
    arena.mode = mode;
    arena.currentTurnIdx = 0;
    arena.pendingActions = {};
    if (mode === 'clock') {
      for (const sid of arena.turnOrder) {
        if (sid !== ENEMY_TURN_ID) arena.pendingActions[sid] = 'stay';
      }
    }
    io.emit('arena:turn-timer',  { timeLeft: 0, total: arena.timerSeconds });
    io.emit('arena:clock-timer', { timeLeft: 0, total: arena.clockSeconds });
    io.emit('arena:state', getArenaSnapshot());
    startArenaTimer();
    addLog(`Arena mode: ${mode}`, 'action');
  });

  socket.on('host:arena-timer-toggle', () => {
    arena.timerEnabled = !arena.timerEnabled;
    clearArenaTimer();
    startArenaTimer();
    if (!arena.timerEnabled) io.emit('arena:turn-timer', { timeLeft: 0, total: arena.timerSeconds });
    io.emit('arena:state', getArenaSnapshot());
  });

  socket.on('host:arena-timer-set', ({ turnSecs, clockSecs }) => {
    if (turnSecs  != null) arena.timerSeconds = Math.max(3, Math.min(120, Math.floor(turnSecs)));
    if (clockSecs != null) arena.clockSeconds = Math.max(3, Math.min(120, Math.floor(clockSecs)));
    clearArenaTimer();
    startArenaTimer();
    io.emit('arena:state', getArenaSnapshot());
  });

  socket.on('host:arena-reset', () => {
    clearArenaTimer();
    arena.players       = {};
    arena.turnOrder     = [];
    arena.currentTurnIdx = 0;
    arena.pendingActions = {};
    spawnEnemiesFromConfig();
    for (const { socketId } of Object.values(state.players)) {
      io.to(socketId).emit('player:load-module', state.currentModule);
    }
    io.emit('arena:state', getArenaSnapshot());
    addLog('Arena reset', 'action');
  });

  // Update enemy spawn positions (host enemy editor)
  socket.on('host:arena-set-enemy-spawns', (spawns) => {
    if (!Array.isArray(spawns)) return;
    arena.enemySpawns = spawns.map(s => ({ x: Math.floor(s.x), y: Math.floor(s.y) }));
    spawnEnemiesFromConfig();
    io.emit('arena:state', getArenaSnapshot());
    addLog(`Enemy spawns updated: ${arena.enemySpawns.length}`, 'info');
  });

  socket.on('host:arena-load-level', (levelId) => {
    const levelPath = path.join(__dirname, 'levels', `${levelId}.json`);
    if (!fs.existsSync(levelPath)) return;
    try {
      const cfg = JSON.parse(fs.readFileSync(levelPath, 'utf8'));
      clearArenaTimer();
      if (cfg.shape && ['rect','circle'].includes(cfg.shape)) arena.shape = cfg.shape;
      if (cfg.width  != null) arena.width  = Math.max(2, Math.min(30, cfg.width));
      if (cfg.height != null) arena.height = Math.max(2, Math.min(30, cfg.height));
      if (cfg.pvp      !== undefined) arena.pvp      = !!cfg.pvp;
      if (cfg.hasEnemy !== undefined) arena.hasEnemy = !!cfg.hasEnemy;
      if (Array.isArray(cfg.enemySpawns)) {
        arena.enemySpawns = cfg.enemySpawns;
        spawnEnemiesFromConfig();
      }
      if (Array.isArray(cfg.walls)) arena.walls = cfg.walls;
      if (arena.shape === 'circle') recalcCircle();
      io.emit('arena:state', getArenaSnapshot());
      io.emit('host:state-update', getStateSnapshot());
      addLog(`Level loaded: ${cfg.name || levelId}`, 'action');
    } catch (e) {}
  });

  // ── Minigame ─────────────────────────────────────────────────────────
  socket.on('minigame:complete', ({ name, game, result }) => {
    const player = Object.values(state.players).find(p => p.name === name);
    if (player) io.to(player.socketId).emit('player:load-module', state.currentModule);
    if (result.fail)         addLog(`${name} · ${game} · FALSE START`, 'result-bad');
    else if (result.timeout) addLog(`${name} · ${game} · TIMEOUT`,     'result-bad');
    else                     addLog(`${name} · ${game} · ${result.time}ms`, 'result-good');
  });

  // ── Chat ──────────────────────────────────────────────────────────────
  socket.on('chat:request-history', () => socket.emit('chat:history', state.chatHistory));
  socket.on('chat:message', ({ name, text }) => {
    if (!text?.trim() || !name) return;
    const msg = { name, text: text.trim(), ts: Date.now() };
    state.chatHistory.push(msg);
    if (state.chatHistory.length > 200) state.chatHistory.shift();
    io.emit('chat:message', msg);
  });

  // ── Character Select ─────────────────────────────────────────────────
  socket.on('character-select:ready', ({ playerClass, colorIndex, movementType, attackType }) => {
    const sp = state.players[socket.id];
    if (!sp) return;
    sp.playerClass   = playerClass;
    sp.colorIndex    = colorIndex;
    sp.movementType  = movementType;
    sp.attackType    = attackType;
    sp.charSelectDone = true;
    io.emit('host:state-update', getStateSnapshot());
    io.emit('character-select:player-ready', {
      name: sp.name, playerClass, colorIndex, movementType, attackType,
    });
    addLog(`${sp.name}: ${playerClass} | ${movementType} | ${attackType}`, 'info');
  });

  // ── Arena (player) ────────────────────────────────────────────────────
  socket.on('arena:join', (name) => {
    const noPlayersBefore = Object.keys(arena.players).length === 0;
    const sp = Object.values(state.players).find(s => s.name === name);
    // Use player's chosen colorIndex from character select, or auto-assign
    const colorIndex = sp?.colorIndex != null ? sp.colorIndex : (arenaColorCounter++ % 8);
    arena.players[socket.id] = { name, x: 0, y: 0, colorIndex, lastDir: 'up' };
    // Insert player before the enemy slot so players always come before enemy in rotation
    if (!arena.turnOrder.includes(socket.id)) {
      const enemyIdx = arena.turnOrder.indexOf(ENEMY_TURN_ID);
      if (enemyIdx !== -1) arena.turnOrder.splice(enemyIdx, 0, socket.id);
      else arena.turnOrder.push(socket.id);
    }
    arena.pendingActions[socket.id] = 'stay';
    if (arena.shape === 'circle') recalcCircle();
    respawnAll();
    socket.emit('arena:joined', {
      ...arena.players[socket.id],
      playerClass:  sp?.playerClass  || 'barbarian',
      movementType: sp?.movementType || 'cardinal',
      attackType:   sp?.attackType   || 'melee',
    });
    io.emit('arena:state', getArenaSnapshot());
    if (noPlayersBefore && arena.mode !== 'free' && arena.mode !== 'freeze') startArenaTimer();
  });

  socket.on('arena:move', (dir) => {
    const p = arena.players[socket.id];
    if (!p || arena.mode === 'freeze') return;
    const DIRS = {
      up:[0,-1], down:[0,1], left:[-1,0], right:[1,0],
      upleft:[-1,-1], upright:[1,-1], downleft:[-1,1], downright:[1,1],
    };
    if (!DIRS[dir]) return;
    if (arena.mode === 'clock') {
      arena.pendingActions[socket.id] = dir;
      socket.emit('arena:action-selected', dir);
      return;
    }
    if (!isMyTurn(socket.id)) return;
    const [dx, dy] = DIRS[dir];
    const nx = p.x + dx, ny = p.y + dy;
    if (canMoveTo(nx, ny)) { p.x = nx; p.y = ny; }
    p.lastDir = dir;
    fireAttack(socket.id, false);
    if (arena.mode === 'turn') advanceTurn();
    else io.emit('arena:state', getArenaSnapshot());
  });

  socket.on('arena:attack', () => {
    const p = arena.players[socket.id];
    if (!p || arena.mode === 'freeze') return;
    if (arena.mode === 'clock') {
      arena.pendingActions[socket.id] = 'stay';
      socket.emit('arena:action-selected', 'stay');
      return;
    }
    if (!isMyTurn(socket.id)) return;
    fireAttack(socket.id, true);
    if (arena.mode === 'turn') advanceTurn();
    else io.emit('arena:state', getArenaSnapshot());
  });

  socket.on('arena:request-state', () => {
    socket.emit('arena:state', getArenaSnapshot());
  });

  // ── Player ────────────────────────────────────────────────────────────
  socket.on('player:join', (name) => {
    state.players[socket.id] = { name, socketId: socket.id };
    socket.emit('player:load-module', state.currentModule);
    io.emit('host:state-update', getStateSnapshot());
    addLog(`"${name}" joined`, 'info');
  });

  // ── Disconnect ────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    if (arena.players[socket.id]) {
      delete arena.pendingActions[socket.id];
      const idx = arena.turnOrder.indexOf(socket.id);
      if (idx !== -1) {
        if (isMyTurn(socket.id) && arena.mode === 'turn') clearArenaTimer();
        arena.turnOrder.splice(idx, 1);
        if (arena.turnOrder.length > 0 && arena.currentTurnIdx >= arena.turnOrder.length)
          arena.currentTurnIdx = 0;
        // Restart timer if someone was waiting on this player's turn
        if (arena.mode === 'turn' && arena.turnOrder.length > 0) {
          const current = arena.turnOrder[arena.currentTurnIdx % arena.turnOrder.length];
          if (current === ENEMY_TURN_ID) startEnemyTurn();
          else startArenaTimer();
        }
      }
      delete arena.players[socket.id];
      if (arena.shape === 'circle' && Object.keys(arena.players).length > 0) recalcCircle();
      io.emit('arena:state', getArenaSnapshot());
    }
    if (state.players[socket.id]) {
      const { name } = state.players[socket.id];
      delete state.players[socket.id];
      io.emit('host:state-update', getStateSnapshot());
      addLog(`"${name}" left`, 'info');
    }
  });
});

// ── Free-mode enemy auto-moves ────────────────────────────────────────
setInterval(() => {
  if (arena.mode === 'free' && arena.hasEnemy && arena.enemies.length > 0 && Object.keys(arena.players).length > 0) {
    moveAndAttackEnemies();
    io.emit('arena:state', getArenaSnapshot());
  }
}, 1500);

// ── Startup init ──────────────────────────────────────────────────────
spawnEnemiesFromConfig();   // populates arena.enemies + adds ENEMY_TURN_ID to turnOrder

server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));

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
const PORT   = 3000;

// ── Class behaviors (data-driven) ─────────────────────────────────────
const CLASS_BEHAVIORS = {
  barbarian: {
    color: '#c0392b',
    attackOnMove: true,
    getAttackPositions(x, y, inBounds) {
      return [{ x, y }, { x, y: y-1 }, { x, y: y+1 }, { x: x-1, y }, { x: x+1, y }]
        .filter(p => inBounds(p.x, p.y));
    },
  },
  wizard: {
    color: '#4a9de0',
    attackOnMove: true,
    getAttackPositions(x, y, inBounds) {
      return [{ x, y }, { x, y: y-1 }, { x, y: y+1 }, { x: x-1, y }, { x: x+1, y }]
        .filter(p => inBounds(p.x, p.y));
    },
  },
  healer: {
    color: '#f5d442',
    attackOnMove: false,
    getAttackPositions(x, y, inBounds) {
      const pos = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (inBounds(nx, ny)) pos.push({ x: nx, y: ny });
        }
      return pos;
    },
  },
};

// ── Display routing ───────────────────────────────────────────────────
const DISPLAY_MAP = {
  'waiting': 'waiting-display',
  'arena':   'arena-display',
  'chat':    'chat-display',
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
  pvp:      false,    // players can kill each other
  hasEnemy: true,     // NPC enemy enabled
  enemy:    { x: 9, y: 7 },
  walls:    [],       // [{ x, y }] impassable tiles

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

function advanceTurn() {
  if (arena.turnOrder.length === 0) return;
  clearArenaTimer();
  arena.currentTurnIdx = (arena.currentTurnIdx + 1) % arena.turnOrder.length;
  io.emit('arena:state', getArenaSnapshot());
  if (arena.hasEnemy && arena.enemy && !arena.pvp) {
    doEnemyTurn(() => { io.emit('arena:state', getArenaSnapshot()); startArenaTimer(); });
  } else {
    startArenaTimer();
  }
}

// ── Class helpers ──────────────────────────────────────────────────────
function getPlayerClass(socketId) {
  const p = arena.players[socketId];
  if (!p) return 'barbarian';
  const sp = Object.values(state.players).find(s => s.name === p.name);
  return sp?.playerClass || 'barbarian';
}

function fireAttack(socketId, isStay) {
  const p = arena.players[socketId];
  if (!p) return;
  const cls      = getPlayerClass(socketId);
  const behavior = CLASS_BEHAVIORS[cls] || CLASS_BEHAVIORS.barbarian;
  if (!behavior.attackOnMove && !isStay) return;  // healer skips on move

  const positions = behavior.getAttackPositions(p.x, p.y, makeInBounds());
  io.emit('arena:area-attack', { positions, color: behavior.color });

  if (arena.pvp) {
    const toKill = [];
    for (const [sid, target] of Object.entries(arena.players)) {
      if (sid === socketId) continue;
      if (positions.some(h => h.x === target.x && h.y === target.y))
        toKill.push({ sid, name: target.name });
    }
    for (const { sid, name } of toKill) killPlayer(sid, name);
  }
  if (arena.hasEnemy && arena.enemy) checkKillEnemy(positions);
}

// ── Clock round ────────────────────────────────────────────────────────
function resolveClockRound() {
  const inBounds = makeInBounds();
  // 1. Move all players simultaneously
  for (const [sid, action] of Object.entries(arena.pendingActions)) {
    const p = arena.players[sid];
    if (!p) continue;
    let nx = p.x, ny = p.y;
    if (action === 'up')    ny--;
    else if (action === 'down')  ny++;
    else if (action === 'left')  nx--;
    else if (action === 'right') nx++;
    if (inBounds(nx, ny) && !isWall(nx, ny)) { p.x = nx; p.y = ny; }
  }
  // 2. Fire all attacks simultaneously
  for (const sid of Object.keys(arena.players)) {
    const action = arena.pendingActions[sid] || 'stay';
    fireAttack(sid, action === 'stay');
  }
  // 3. Enemy turn (if applicable), then reset and restart
  const afterClock = () => {
    arena.pendingActions = {};
    for (const sid of arena.turnOrder) arena.pendingActions[sid] = 'stay';
    io.emit('arena:clock-round-end');
    io.emit('arena:state', getArenaSnapshot());
    startArenaTimer();
  };
  if (arena.hasEnemy && arena.enemy && !arena.pvp) {
    doEnemyTurn(afterClock);
  } else {
    afterClock();
  }
}

// ── Enemy AI ───────────────────────────────────────────────────────────
function doEnemyTurn(cb) {
  if (!arena.enemy) { cb(); return; }
  setTimeout(() => { moveAndAttackEnemy(); cb(); }, 700);
}

function moveAndAttackEnemy() {
  if (!arena.enemy) return;
  const players = Object.values(arena.players);
  if (players.length === 0) return;

  // Find nearest player (Manhattan distance)
  let nearest = null, minDist = Infinity;
  for (const p of players) {
    const d = Math.abs(p.x - arena.enemy.x) + Math.abs(p.y - arena.enemy.y);
    if (d < minDist) { minDist = d; nearest = p; }
  }
  if (!nearest) return;

  // Move one step toward nearest
  const dx = nearest.x - arena.enemy.x;
  const dy = nearest.y - arena.enemy.y;
  const inBounds = makeInBounds();
  let nx = arena.enemy.x, ny = arena.enemy.y;
  if (Math.abs(dx) >= Math.abs(dy)) nx += dx > 0 ? 1 : -1;
  else                               ny += dy > 0 ? 1 : -1;
  if (inBounds(nx, ny) && !isWall(nx, ny)) { arena.enemy.x = nx; arena.enemy.y = ny; }

  // Flash cross hit zone
  const { x, y } = arena.enemy;
  const hitZone = [{ x, y }, { x, y: y-1 }, { x, y: y+1 }, { x: x-1, y }, { x: x+1, y }]
    .filter(h => inBounds(h.x, h.y));
  io.emit('arena:area-attack', { positions: hitZone, color: '#c0392b' });

  const toKill = [];
  for (const [sid, p] of Object.entries(arena.players)) {
    if (hitZone.some(h => h.x === p.x && h.y === p.y)) toKill.push({ sid, name: p.name });
  }
  for (const { sid, name } of toKill) killPlayer(sid, name);
}

function checkKillEnemy(positions) {
  if (!arena.enemy) return;
  if (positions.some(p => p.x === arena.enemy.x && p.y === arena.enemy.y)) {
    arena.enemy = null;
    addLog('Enemy defeated!', 'result-good');
  }
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
  const curPlayer = curSid ? arena.players[curSid] : null;
  return {
    shape:        arena.shape,
    width:        arena.width,
    height:       arena.height,
    radius:       arena.radius,
    gridSize:     arena.gridSize,
    pvp:          arena.pvp,
    hasEnemy:     arena.hasEnemy,
    enemy:        arena.enemy,
    walls:        arena.walls,
    players:      Object.values(arena.players),
    mode:         arena.mode,
    timerEnabled: arena.timerEnabled,
    timerSeconds: arena.timerSeconds,
    clockSeconds: arena.clockSeconds,
    timeLeft:     arena.timeLeft,
    currentTurn:  curPlayer ? curPlayer.name : null,
    pendingActions: arena.mode === 'clock' ? arena.pendingActions : {},
  };
}

function getStateSnapshot() {
  return {
    players:        Object.values(state.players),
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
      if (arena.hasEnemy && !arena.enemy) arena.enemy = { x: arena.width - 1, y: arena.height - 1 };
      else if (!arena.hasEnemy) arena.enemy = null;
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
    if (mode === 'clock') for (const sid of arena.turnOrder) arena.pendingActions[sid] = 'stay';
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
    if (arena.hasEnemy) arena.enemy = { x: arena.width - 1, y: arena.height - 1 };
    for (const { socketId } of Object.values(state.players)) {
      io.to(socketId).emit('player:load-module', state.currentModule);
    }
    io.emit('arena:state', getArenaSnapshot());
    addLog('Arena reset', 'action');
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
      if (cfg.hasEnemy !== undefined) {
        arena.hasEnemy = !!cfg.hasEnemy;
        arena.enemy    = arena.hasEnemy ? { x: arena.width - 1, y: arena.height - 1 } : null;
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

  // ── Arena (player) ────────────────────────────────────────────────────
  socket.on('arena:join', (name) => {
    const wasEmpty = arena.turnOrder.length === 0;
    arena.players[socket.id] = { name, x: 0, y: 0, colorIndex: arenaColorCounter++ % 8 };
    if (!arena.turnOrder.includes(socket.id)) arena.turnOrder.push(socket.id);
    arena.pendingActions[socket.id] = 'stay';
    if (arena.shape === 'circle') recalcCircle();
    respawnAll();
    const sp = Object.values(state.players).find(s => s.name === name);
    socket.emit('arena:joined', { ...arena.players[socket.id], playerClass: sp?.playerClass || 'barbarian' });
    io.emit('arena:state', getArenaSnapshot());
    if (wasEmpty && arena.mode !== 'free' && arena.mode !== 'freeze') startArenaTimer();
  });

  socket.on('arena:move', (dir) => {
    const p = arena.players[socket.id];
    if (!p || arena.mode === 'freeze') return;
    if (arena.mode === 'clock') {
      arena.pendingActions[socket.id] = dir;
      socket.emit('arena:action-selected', dir);
      return;
    }
    if (!isMyTurn(socket.id)) return;
    let nx = p.x, ny = p.y;
    if (dir === 'up')    ny--;
    if (dir === 'down')  ny++;
    if (dir === 'left')  nx--;
    if (dir === 'right') nx++;
    if (canMoveTo(nx, ny)) { p.x = nx; p.y = ny; }
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
        if (arena.mode === 'turn' && arena.turnOrder.length > 0) startArenaTimer();
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
  if (arena.mode === 'free' && arena.hasEnemy && arena.enemy && Object.keys(arena.players).length > 0) {
    moveAndAttackEnemy();
    io.emit('arena:state', getArenaSnapshot());
  }
}, 1500);

server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));

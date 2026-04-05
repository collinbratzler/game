const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

const CLASS_COLORS = {
  'barbarian': '#c0392b',
  'wizard':    '#4a9de0',
  'healer':    '#f5d442',
};

// Maps player module id → what the display screen should load
const DISPLAY_MAP = {
  'waiting': 'waiting-display',
  'dungeon': 'dungeon-display',
  'chat':    'chat-display',
  'pvp':     'pvp-display',
};

function toDisplayModule(moduleId) {
  return DISPLAY_MAP[moduleId] || moduleId;
}

// Game state
const state = {
  players: {},         // socketId -> { name, socketId }
  currentModule: 'waiting',
  currentDisplay: toDisplayModule('waiting'),
  chatHistory: [],     // { name, text, ts }
  activityLog: [],     // { ts, message, type }
};

// Dungeon state
const dungeon = {
  width: 10,
  height: 8,
  players: {},         // socketId -> { name, x, y, colorIndex }
  mode: 'turn',        // 'free' | 'turn' | 'clock'
  timerEnabled: false,
  timerSeconds: 8,
  clockSeconds: 5,
  currentTurnIdx: 0,
  turnOrder: [],
  enemy: { x: 9, y: 7 },
  timerInterval: null,
  timeLeft: 0,
  pendingActions: {},  // socketId -> 'up'|'down'|'left'|'right'|'stay'
};
let dungeonColorCounter = 0;

function clearDungeonTimer() {
  if (dungeon.timerInterval) { clearInterval(dungeon.timerInterval); dungeon.timerInterval = null; }
}

function startDungeonTimer() {
  clearDungeonTimer();
  if (dungeon.mode === 'turn' && dungeon.timerEnabled && dungeon.turnOrder.length > 0) {
    dungeon.timeLeft = dungeon.timerSeconds;
    io.emit('dungeon:turn-timer', { timeLeft: dungeon.timeLeft, total: dungeon.timerSeconds });
    dungeon.timerInterval = setInterval(() => {
      dungeon.timeLeft--;
      io.emit('dungeon:turn-timer', { timeLeft: dungeon.timeLeft, total: dungeon.timerSeconds });
      if (dungeon.timeLeft <= 0) {
        clearDungeonTimer();
        dungeon.currentTurnIdx = (dungeon.currentTurnIdx + 1) % dungeon.turnOrder.length;
        doEnemyTurn(() => { io.emit('dungeon:state', getDungeonSnapshot()); startDungeonTimer(); });
      }
    }, 1000);
  } else if (dungeon.mode === 'clock' && dungeon.turnOrder.length > 0) {
    dungeon.timeLeft = dungeon.clockSeconds;
    io.emit('dungeon:clock-timer', { timeLeft: dungeon.timeLeft, total: dungeon.clockSeconds });
    dungeon.timerInterval = setInterval(() => {
      dungeon.timeLeft--;
      io.emit('dungeon:clock-timer', { timeLeft: dungeon.timeLeft, total: dungeon.clockSeconds });
      if (dungeon.timeLeft <= 0) {
        clearDungeonTimer();
        resolveClockRound();
      }
    }, 1000);
  }
}

function resolveClockRound() {
  // Move all players simultaneously
  for (const [sid, action] of Object.entries(dungeon.pendingActions)) {
    const p = dungeon.players[sid];
    if (!p) continue;
    if (action === 'up'    && p.y > 0)                  p.y--;
    else if (action === 'down'  && p.y < dungeon.height-1) p.y++;
    else if (action === 'left'  && p.x > 0)             p.x--;
    else if (action === 'right' && p.x < dungeon.width-1)  p.x++;
  }
  // Fire all attacks simultaneously
  for (const [sid, p] of Object.entries(dungeon.players)) {
    const action = dungeon.pendingActions[sid] || 'stay';
    const sp = Object.values(state.players).find(s => s.name === p.name);
    const cls = sp?.playerClass || 'barbarian';
    const isHealer = cls === 'healer';
    if (isHealer && action !== 'stay') continue; // healers only attack on stay
    const { x, y } = p;
    let positions;
    if (isHealer) {
      positions = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x+dx, ny = y+dy;
          if (nx >= 0 && nx < dungeon.width && ny >= 0 && ny < dungeon.height) positions.push({x:nx,y:ny});
        }
    } else {
      positions = [{x,y},{x,y:y-1},{x,y:y+1},{x:x-1,y},{x:x+1,y}]
        .filter(h => h.x >= 0 && h.x < dungeon.width && h.y >= 0 && h.y < dungeon.height);
    }
    io.emit('dungeon:area-attack', { positions, color: CLASS_COLORS[cls] });
    checkKillEnemy(positions);
  }
  // Enemy turn after a brief delay
  doEnemyTurn(() => {
    // Reset pending actions to 'stay'
    dungeon.pendingActions = {};
    for (const sid of dungeon.turnOrder) dungeon.pendingActions[sid] = 'stay';
    io.emit('dungeon:state', getDungeonSnapshot());
    startDungeonTimer();
  });
}

function doEnemyTurn(cb) {
  if (!dungeon.enemy) { cb(); return; }
  setTimeout(() => { moveAndAttackEnemy(); cb(); }, 700);
}

function checkKillEnemy(positions) {
  if (!dungeon.enemy) return;
  if (positions.some(p => p.x === dungeon.enemy.x && p.y === dungeon.enemy.y)) {
    dungeon.enemy = null;
    addLog('Enemy defeated!', 'result-good');
  }
}

function isMyTurn(socketId) {
  if (dungeon.mode !== 'turn' || dungeon.turnOrder.length === 0) return true;
  return dungeon.turnOrder[dungeon.currentTurnIdx % dungeon.turnOrder.length] === socketId;
}

function advanceTurn() {
  if (dungeon.turnOrder.length === 0) return;
  clearDungeonTimer();
  dungeon.currentTurnIdx = (dungeon.currentTurnIdx + 1) % dungeon.turnOrder.length;
  io.emit('dungeon:state', getDungeonSnapshot());
  doEnemyTurn(() => { io.emit('dungeon:state', getDungeonSnapshot()); startDungeonTimer(); });
}

function killPlayer(dungeonSocketId, name) {
  const idx = dungeon.turnOrder.indexOf(dungeonSocketId);
  if (idx !== -1) {
    dungeon.turnOrder.splice(idx, 1);
    if (dungeon.turnOrder.length > 0 && dungeon.currentTurnIdx >= dungeon.turnOrder.length) {
      dungeon.currentTurnIdx = 0;
    }
  }
  delete dungeon.players[dungeonSocketId];

  // Find the player's player.html socket (different socket from dungeon iframe)
  const statePlayer = Object.values(state.players).find(p => p.name === name);
  if (statePlayer) {
    io.to(statePlayer.socketId).emit('player:load-module', 'dungeon-dead');
  }
  addLog(`☠ ${name} killed by the enemy`, 'result-bad');
}

function moveAndAttackEnemy() {
  if (!dungeon.enemy) return;
  const players = Object.values(dungeon.players);
  if (players.length === 0) return;

  // Find nearest player by Manhattan distance
  let nearest = null, minDist = Infinity;
  for (const p of players) {
    const dist = Math.abs(p.x - dungeon.enemy.x) + Math.abs(p.y - dungeon.enemy.y);
    if (dist < minDist) { minDist = dist; nearest = p; }
  }
  if (!nearest) return;

  // Move one step toward nearest player
  const dx = nearest.x - dungeon.enemy.x;
  const dy = nearest.y - dungeon.enemy.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    dungeon.enemy.x = Math.max(0, Math.min(dungeon.width  - 1, dungeon.enemy.x + (dx > 0 ? 1 : -1)));
  } else {
    dungeon.enemy.y = Math.max(0, Math.min(dungeon.height - 1, dungeon.enemy.y + (dy > 0 ? 1 : -1)));
  }

  // Check hit zone: enemy square + 4 cardinal adjacents
  const { x, y } = dungeon.enemy;
  const hitZone = [{ x, y }, { x, y: y-1 }, { x, y: y+1 }, { x: x-1, y }, { x: x+1, y }];

  const toKill = [];
  for (const [sid, p] of Object.entries(dungeon.players)) {
    if (hitZone.some(h => h.x === p.x && h.y === p.y)) toKill.push({ sid, name: p.name });
  }

  // Always flash the full hit zone when the enemy acts
  const hitZoneInBounds = hitZone.filter(
    h => h.x >= 0 && h.x < dungeon.width && h.y >= 0 && h.y < dungeon.height
  );
  io.emit('dungeon:area-attack', { positions: hitZoneInBounds, color: '#c0392b' });
  for (const { sid, name } of toKill) killPlayer(sid, name);
}

// PvP state
const pvp = {
  players:          {},   // socketId -> { name, x, y, colorIndex }
  mode:             'turn', // 'free' | 'turn' | 'clock'
  timerEnabled:     false,
  timerSeconds:     8,
  clockSeconds:     5,
  currentTurnIdx:   0,
  turnOrder:        [],
  radius:           5,
  gridSize:         11,   // 2*radius+1
  timerInterval:    null,
  timeLeft:         0,
  pendingActions:   {},
};
let pvpColorCounter = 0;

function clearPvpTimer() {
  if (pvp.timerInterval) { clearInterval(pvp.timerInterval); pvp.timerInterval = null; }
}

function startPvpTimer() {
  clearPvpTimer();
  if (pvp.mode === 'turn' && pvp.timerEnabled && pvp.turnOrder.length > 0) {
    pvp.timeLeft = pvp.timerSeconds;
    io.emit('pvp:turn-timer', { timeLeft: pvp.timeLeft, total: pvp.timerSeconds });
    pvp.timerInterval = setInterval(() => {
      pvp.timeLeft--;
      io.emit('pvp:turn-timer', { timeLeft: pvp.timeLeft, total: pvp.timerSeconds });
      if (pvp.timeLeft <= 0) {
        clearPvpTimer();
        pvp.currentTurnIdx = (pvp.currentTurnIdx + 1) % pvp.turnOrder.length;
        io.emit('pvp:state', getPvpSnapshot());
        startPvpTimer();
      }
    }, 1000);
  } else if (pvp.mode === 'clock' && pvp.turnOrder.length > 0) {
    pvp.timeLeft = pvp.clockSeconds;
    io.emit('pvp:clock-timer', { timeLeft: pvp.timeLeft, total: pvp.clockSeconds });
    pvp.timerInterval = setInterval(() => {
      pvp.timeLeft--;
      io.emit('pvp:clock-timer', { timeLeft: pvp.timeLeft, total: pvp.clockSeconds });
      if (pvp.timeLeft <= 0) {
        clearPvpTimer();
        resolvePvpClockRound();
      }
    }, 1000);
  }
}

function resolvePvpClockRound() {
  for (const [sid, action] of Object.entries(pvp.pendingActions)) {
    const p = pvp.players[sid];
    if (!p) continue;
    let nx = p.x, ny = p.y;
    if (action === 'up')    ny--;
    else if (action === 'down')  ny++;
    else if (action === 'left')  nx--;
    else if (action === 'right') nx++;
    if (pvpIsInCircle(nx, ny)) { p.x = nx; p.y = ny; }
  }
  for (const [sid, p] of Object.entries(pvp.players)) {
    const action = pvp.pendingActions[sid] || 'stay';
    const sp = Object.values(state.players).find(s => s.name === p.name);
    const cls = sp?.playerClass || 'barbarian';
    const isHealer = cls === 'healer';
    if (isHealer && action !== 'stay') continue;
    const { x, y } = p;
    let positions;
    if (isHealer) {
      positions = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x+dx, ny = y+dy;
          if (pvpIsInCircle(nx, ny)) positions.push({x:nx,y:ny});
        }
    } else {
      positions = [{x,y},{x,y:y-1},{x,y:y+1},{x:x-1,y},{x:x+1,y}].filter(h => pvpIsInCircle(h.x, h.y));
    }
    io.emit('pvp:area-attack', { positions, color: CLASS_COLORS[cls] });
    pvpCheckKillPlayers(sid, positions);
  }
  pvp.pendingActions = {};
  for (const sid of pvp.turnOrder) pvp.pendingActions[sid] = 'stay';
  io.emit('pvp:state', getPvpSnapshot());
  startPvpTimer();
}

function pvpIsInCircle(x, y) {
  const c = Math.floor(pvp.gridSize / 2);
  return (x - c) * (x - c) + (y - c) * (y - c) <= pvp.radius * pvp.radius;
}

function pvpRecalcAndRespawn() {
  const entries = Object.entries(pvp.players);
  const n = entries.length;
  pvp.radius   = Math.max(5, 4 + Math.ceil(n / 2));
  pvp.gridSize = 2 * pvp.radius + 1;
  const c = Math.floor(pvp.gridSize / 2);
  const spawnR = Math.round(pvp.radius * 0.65);
  entries.forEach(([, p], i) => {
    const angle = (2 * Math.PI * i / n) - Math.PI / 2;
    p.x = c + Math.round(spawnR * Math.cos(angle));
    p.y = c + Math.round(spawnR * Math.sin(angle));
  });
}

function pvpIsMyTurn(socketId) {
  if (pvp.mode !== 'turn' || pvp.turnOrder.length === 0) return true;
  return pvp.turnOrder[pvp.currentTurnIdx % pvp.turnOrder.length] === socketId;
}

function pvpAdvanceTurn() {
  if (pvp.turnOrder.length === 0) return;
  clearPvpTimer();
  pvp.currentTurnIdx = (pvp.currentTurnIdx + 1) % pvp.turnOrder.length;
  io.emit('pvp:state', getPvpSnapshot());
  startPvpTimer();
}

function pvpKillPlayer(socketId, name) {
  const idx = pvp.turnOrder.indexOf(socketId);
  if (idx !== -1) {
    pvp.turnOrder.splice(idx, 1);
    if (pvp.turnOrder.length > 0 && pvp.currentTurnIdx >= pvp.turnOrder.length) {
      pvp.currentTurnIdx = 0;
    }
  }
  delete pvp.players[socketId];
  const statePlayer = Object.values(state.players).find(p => p.name === name);
  if (statePlayer) io.to(statePlayer.socketId).emit('player:load-module', 'dungeon-dead');
  addLog(`☠ ${name} eliminated in PvP`, 'result-bad');
}

function pvpCheckKillPlayers(attackerSocketId, positions) {
  const toKill = [];
  for (const [sid, p] of Object.entries(pvp.players)) {
    if (sid === attackerSocketId) continue;
    if (positions.some(h => h.x === p.x && h.y === p.y)) toKill.push({ sid, name: p.name });
  }
  for (const { sid, name } of toKill) pvpKillPlayer(sid, name);
}

function getPvpSnapshot() {
  const activeLen = pvp.turnOrder.length;
  const curSid = pvp.turnBased && activeLen > 0
    ? pvp.turnOrder[pvp.currentTurnIdx % activeLen] : null;
  const curPlayer = curSid ? pvp.players[curSid] : null;
  return {
    players:        Object.values(pvp.players),
    radius:         pvp.radius,
    gridSize:       pvp.gridSize,
    mode:           pvp.mode,
    timerEnabled:   pvp.timerEnabled,
    timerSeconds:   pvp.timerSeconds,
    clockSeconds:   pvp.clockSeconds,
    timeLeft:       pvp.timeLeft,
    currentTurn:    curPlayer ? curPlayer.name : null,
    pendingActions: pvp.mode === 'clock' ? pvp.pendingActions : {},
  };
}

app.use(express.static('public'));

function getLocalIP() {
  const candidates = [];
  for (const nets of Object.values(os.networkInterfaces())) {
    for (const net of nets) {
      if (net.family !== 'IPv4' || net.internal) continue;
      candidates.push(net.address);
    }
  }
  // Prefer typical LAN ranges over VPN ranges (Tailscale uses 100.x.x.x)
  const lan = candidates.find(ip => /^192\.168\./.test(ip))
           || candidates.find(ip => /^10\./.test(ip))
           || candidates.find(ip => /^172\.(1[6-9]|2\d|3[01])\./.test(ip))
           || candidates[0]
           || 'localhost';
  return lan;
}

app.get('/api/join-url', (req, res) => {
  res.json({ url: `http://${getLocalIP()}:${PORT}/player.html` });
});

app.get('/api/qr.svg', async (req, res) => {
  const url = `http://${getLocalIP()}:${PORT}/player.html`;
  const svg = await QRCode.toString(url, {
    type: 'svg',
    margin: 1,
    color: { dark: '#1a1a1a', light: '#f7f6f3' },
  });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

function addLog(message, type = 'info') {
  const entry = { ts: Date.now(), message, type };
  state.activityLog.push(entry);
  if (state.activityLog.length > 200) state.activityLog.shift();
  io.emit('host:log-update', state.activityLog);
}

io.on('connection', (socket) => {

  // --- Host events ---

  socket.on('host:request-state', () => {
    socket.emit('host:state-update', getStateSnapshot());
    socket.emit('host:log-update', state.activityLog);
    socket.emit('dungeon:state', getDungeonSnapshot());
    socket.emit('pvp:state', getPvpSnapshot());
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

  socket.on('host:dungeon-resize', ({ width, height }) => {
    dungeon.width  = Math.max(2, Math.min(30, Math.floor(width)));
    dungeon.height = Math.max(2, Math.min(30, Math.floor(height)));
    for (const p of Object.values(dungeon.players)) {
      p.x = Math.min(p.x, dungeon.width  - 1);
      p.y = Math.min(p.y, dungeon.height - 1);
    }
    io.emit('dungeon:state', getDungeonSnapshot());
    io.emit('host:state-update', getStateSnapshot());
    addLog(`Dungeon grid: ${dungeon.width}×${dungeon.height}`, 'info');
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
    players.forEach(({ socketId }) => {
      io.to(socketId).emit('player:load-module', minigame);
    });
    addLog(`Sent "${minigame}" → all (${players.length})`, 'minigame');
  });

  // --- Minigame events ---

  socket.on('minigame:complete', ({ name, game, result }) => {
    // Find the player's player.html socket and return them to the default screen
    const player = Object.values(state.players).find(p => p.name === name);
    if (player) {
      io.to(player.socketId).emit('player:load-module', state.currentModule);
    }
    // Log result
    if (result.fail) {
      addLog(`${name} · ${game} · FALSE START`, 'result-bad');
    } else if (result.timeout) {
      addLog(`${name} · ${game} · TIMEOUT`, 'result-bad');
    } else {
      addLog(`${name} · ${game} · ${result.time}ms`, 'result-good');
    }
  });

  // --- Chat events ---

  socket.on('chat:request-history', () => {
    socket.emit('chat:history', state.chatHistory);
  });

  socket.on('chat:message', ({ name, text }) => {
    if (!text || !text.trim() || !name) return;
    const msg = { name, text: text.trim(), ts: Date.now() };
    state.chatHistory.push(msg);
    if (state.chatHistory.length > 200) state.chatHistory.shift();
    io.emit('chat:message', msg);
  });

  // --- Dungeon events ---

  socket.on('dungeon:join', (name) => {
    dungeon.players[socket.id] = {
      name,
      x: Math.floor(dungeon.width  / 2),
      y: Math.floor(dungeon.height / 2),
      colorIndex: dungeonColorCounter++ % 8,
    };
    const wasEmpty = dungeon.turnOrder.length === 0;
    if (!dungeon.turnOrder.includes(socket.id)) dungeon.turnOrder.push(socket.id);
    dungeon.pendingActions[socket.id] = 'stay';
    const joinStatePlayer = Object.values(state.players).find(sp => sp.name === name);
    const joinClass = joinStatePlayer?.playerClass || 'barbarian';
    socket.emit('dungeon:joined', { ...dungeon.players[socket.id], playerClass: joinClass });
    io.emit('dungeon:state', getDungeonSnapshot());
    if (wasEmpty && dungeon.mode !== 'free') startDungeonTimer();
  });

  socket.on('dungeon:move', (dir) => {
    const p = dungeon.players[socket.id];
    if (!p) return;
    if (dungeon.mode === 'clock') {
      dungeon.pendingActions[socket.id] = dir;
      socket.emit('dungeon:action-selected', dir);
      return;
    }
    if (!isMyTurn(socket.id)) return;
    if (dir === 'up'    && p.y > 0)                   p.y--;
    if (dir === 'down'  && p.y < dungeon.height - 1)  p.y++;
    if (dir === 'left'  && p.x > 0)                   p.x--;
    if (dir === 'right' && p.x < dungeon.width  - 1)  p.x++;
    const statePlayer = Object.values(state.players).find(sp => sp.name === p.name);
    const playerClass = statePlayer?.playerClass || 'barbarian';
    if (playerClass !== 'healer') {
      const { x, y } = p;
      const positions = [{ x, y }, { x, y: y-1 }, { x, y: y+1 }, { x: x-1, y }, { x: x+1, y }]
        .filter(h => h.x >= 0 && h.x < dungeon.width && h.y >= 0 && h.y < dungeon.height);
      io.emit('dungeon:area-attack', { positions, color: CLASS_COLORS[playerClass] });
      checkKillEnemy(positions);
    }
    if (dungeon.mode === 'turn') advanceTurn();
    else io.emit('dungeon:state', getDungeonSnapshot());
  });

  socket.on('dungeon:attack', () => {
    const p = dungeon.players[socket.id];
    if (!p) return;
    if (dungeon.mode === 'clock') {
      dungeon.pendingActions[socket.id] = 'stay';
      socket.emit('dungeon:action-selected', 'stay');
      return;
    }
    if (!isMyTurn(socket.id)) return;
    const { x, y } = p;
    const statePlayer = Object.values(state.players).find(sp => sp.name === p.name);
    const playerClass = statePlayer?.playerClass || 'barbarian';
    const color = CLASS_COLORS[playerClass];
    let positions;
    if (playerClass === 'healer') {
      positions = [];
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && nx < dungeon.width && ny >= 0 && ny < dungeon.height)
            positions.push({ x: nx, y: ny });
        }
      }
    } else {
      positions = [{ x, y }, { x, y: y-1 }, { x, y: y+1 }, { x: x-1, y }, { x: x+1, y }]
        .filter(h => h.x >= 0 && h.x < dungeon.width && h.y >= 0 && h.y < dungeon.height);
    }
    io.emit('dungeon:area-attack', { positions, color });
    checkKillEnemy(positions);
    if (dungeon.mode === 'turn') advanceTurn();
    else io.emit('dungeon:state', getDungeonSnapshot());
  });

  socket.on('host:set-class', ({ socketId, playerClass }) => {
    if (state.players[socketId]) {
      state.players[socketId].playerClass = playerClass;
      const playerName = state.players[socketId].name;
      const dungeonEntry = Object.entries(dungeon.players).find(([, p]) => p.name === playerName);
      if (dungeonEntry) io.to(dungeonEntry[0]).emit('dungeon:class-update', playerClass);
      const pvpEntry = Object.entries(pvp.players).find(([, p]) => p.name === playerName);
      if (pvpEntry) io.to(pvpEntry[0]).emit('pvp:class-update', playerClass);
      io.emit('host:state-update', getStateSnapshot());
    }
  });

  // --- PvP events ---

  socket.on('pvp:join', (name) => {
    const wasEmpty = pvp.turnOrder.length === 0;
    pvp.players[socket.id] = { name, x: 0, y: 0, colorIndex: pvpColorCounter++ % 8 };
    if (!pvp.turnOrder.includes(socket.id)) pvp.turnOrder.push(socket.id);
    pvpRecalcAndRespawn();
    const sp = Object.values(state.players).find(s => s.name === name);
    const playerClass = sp?.playerClass || 'barbarian';
    socket.emit('pvp:joined', { ...pvp.players[socket.id], playerClass });
    io.emit('pvp:state', getPvpSnapshot());
    pvp.pendingActions[socket.id] = 'stay';
    if (wasEmpty && pvp.mode !== 'free') startPvpTimer();
  });

  socket.on('pvp:move', (dir) => {
    const p = pvp.players[socket.id];
    if (!p) return;
    if (pvp.mode === 'clock') {
      pvp.pendingActions[socket.id] = dir;
      socket.emit('pvp:action-selected', dir);
      return;
    }
    if (!pvpIsMyTurn(socket.id)) return;
    let nx = p.x, ny = p.y;
    if (dir === 'up')    ny--;
    if (dir === 'down')  ny++;
    if (dir === 'left')  nx--;
    if (dir === 'right') nx++;
    if (pvpIsInCircle(nx, ny)) { p.x = nx; p.y = ny; }
    const sp = Object.values(state.players).find(s => s.name === p.name);
    const playerClass = sp?.playerClass || 'barbarian';
    if (playerClass !== 'healer') {
      const { x, y } = p;
      const positions = [{ x, y }, { x, y: y-1 }, { x, y: y+1 }, { x: x-1, y }, { x: x+1, y }]
        .filter(h => pvpIsInCircle(h.x, h.y));
      io.emit('pvp:area-attack', { positions, color: CLASS_COLORS[playerClass] });
      pvpCheckKillPlayers(socket.id, positions);
    }
    if (pvp.mode === 'turn') pvpAdvanceTurn();
    else io.emit('pvp:state', getPvpSnapshot());
  });

  socket.on('pvp:attack', () => {
    const p = pvp.players[socket.id];
    if (!p) return;
    if (pvp.mode === 'clock') {
      pvp.pendingActions[socket.id] = 'stay';
      socket.emit('pvp:action-selected', 'stay');
      return;
    }
    if (!pvpIsMyTurn(socket.id)) return;
    if (pvp.mode === 'turn') pvpAdvanceTurn();
    const { x, y } = p;
    const sp = Object.values(state.players).find(s => s.name === p.name);
    const playerClass = sp?.playerClass || 'barbarian';
    const color = CLASS_COLORS[playerClass];
    let positions;
    if (playerClass === 'healer') {
      positions = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (pvpIsInCircle(nx, ny)) positions.push({ x: nx, y: ny });
        }
    } else {
      positions = [{ x, y }, { x, y: y-1 }, { x, y: y+1 }, { x: x-1, y }, { x: x+1, y }]
        .filter(h => pvpIsInCircle(h.x, h.y));
    }
    io.emit('pvp:area-attack', { positions, color });
    pvpCheckKillPlayers(socket.id, positions);
    if (pvp.mode !== 'turn') io.emit('pvp:state', getPvpSnapshot());
  });

  socket.on('pvp:request-state', () => {
    socket.emit('pvp:state', getPvpSnapshot());
  });

  socket.on('host:pvp-reset', () => {
    clearPvpTimer();
    pvp.players = {};
    pvp.turnOrder = [];
    pvp.currentTurnIdx = 0;
    pvp.pendingActions = {};
    pvp.radius   = 5;
    pvp.gridSize = 11;
    for (const { socketId } of Object.values(state.players)) {
      io.to(socketId).emit('player:load-module', state.currentModule);
    }
    io.emit('pvp:state', getPvpSnapshot());
    addLog('PvP reset', 'action');
  });

  socket.on('host:pvp-mode', (mode) => {
    if (!['free','turn','clock'].includes(mode)) return;
    clearPvpTimer();
    pvp.mode = mode;
    pvp.currentTurnIdx = 0;
    pvp.pendingActions = {};
    if (mode === 'clock') for (const sid of pvp.turnOrder) pvp.pendingActions[sid] = 'stay';
    io.emit('pvp:turn-timer',  { timeLeft: 0, total: pvp.timerSeconds });
    io.emit('pvp:clock-timer', { timeLeft: 0, total: pvp.clockSeconds });
    io.emit('pvp:state', getPvpSnapshot());
    startPvpTimer();
    addLog(`PvP mode: ${mode}`, 'action');
  });

  socket.on('host:pvp-timer-toggle', () => {
    pvp.timerEnabled = !pvp.timerEnabled;
    clearPvpTimer();
    startPvpTimer();
    if (!pvp.timerEnabled) io.emit('pvp:turn-timer', { timeLeft: 0, total: pvp.timerSeconds });
    io.emit('pvp:state', getPvpSnapshot());
  });

  socket.on('host:pvp-timer-set', ({ turnSecs, clockSecs }) => {
    if (turnSecs  != null) pvp.timerSeconds = Math.max(3, Math.min(120, Math.floor(turnSecs)));
    if (clockSecs != null) pvp.clockSeconds = Math.max(3, Math.min(120, Math.floor(clockSecs)));
    clearPvpTimer();
    startPvpTimer();
    io.emit('pvp:state', getPvpSnapshot());
  });

  socket.on('host:dungeon-mode', (mode) => {
    if (!['free','turn','clock'].includes(mode)) return;
    clearDungeonTimer();
    dungeon.mode = mode;
    dungeon.currentTurnIdx = 0;
    dungeon.pendingActions = {};
    if (mode === 'clock') for (const sid of dungeon.turnOrder) dungeon.pendingActions[sid] = 'stay';
    io.emit('dungeon:turn-timer', { timeLeft: 0, total: dungeon.timerSeconds });
    io.emit('dungeon:clock-timer', { timeLeft: 0, total: dungeon.clockSeconds });
    io.emit('dungeon:state', getDungeonSnapshot());
    startDungeonTimer();
    addLog(`Dungeon mode: ${mode}`, 'action');
  });

  socket.on('host:dungeon-timer-toggle', () => {
    dungeon.timerEnabled = !dungeon.timerEnabled;
    clearDungeonTimer();
    startDungeonTimer();
    if (!dungeon.timerEnabled) io.emit('dungeon:turn-timer', { timeLeft: 0, total: dungeon.timerSeconds });
    io.emit('dungeon:state', getDungeonSnapshot());
  });

  socket.on('host:dungeon-timer-set', ({ turnSecs, clockSecs }) => {
    if (turnSecs  != null) dungeon.timerSeconds  = Math.max(3, Math.min(120, Math.floor(turnSecs)));
    if (clockSecs != null) dungeon.clockSeconds  = Math.max(3, Math.min(120, Math.floor(clockSecs)));
    clearDungeonTimer();
    startDungeonTimer();
    io.emit('dungeon:state', getDungeonSnapshot());
  });

  socket.on('host:dungeon-reset', () => {
    clearDungeonTimer();
    dungeon.players = {};
    dungeon.turnOrder = [];
    dungeon.currentTurnIdx = 0;
    dungeon.pendingActions = {};
    dungeon.enemy = { x: dungeon.width - 1, y: dungeon.height - 1 };
    // Reload all connected players' module iframes
    for (const { socketId } of Object.values(state.players)) {
      io.to(socketId).emit('player:load-module', state.currentModule);
    }
    io.emit('dungeon:state', getDungeonSnapshot());
    addLog('Dungeon reset', 'action');
  });

  socket.on('dungeon:request-state', () => {
    socket.emit('dungeon:state', getDungeonSnapshot());
  });

  // --- Player events ---

  socket.on('player:join', (name) => {
    state.players[socket.id] = { name, socketId: socket.id };
    socket.emit('player:load-module', state.currentModule);
    io.emit('host:state-update', getStateSnapshot());
    addLog(`"${name}" joined`, 'info');
  });

  // --- Disconnect ---

  socket.on('disconnect', () => {
    if (dungeon.players[socket.id]) {
      delete dungeon.pendingActions[socket.id];
      if (isMyTurn(socket.id) && dungeon.mode === 'turn') clearDungeonTimer();
    }
    if (pvp.players[socket.id]) {
      const idx = pvp.turnOrder.indexOf(socket.id);
      if (idx !== -1) {
        pvp.turnOrder.splice(idx, 1);
        if (pvp.turnOrder.length > 0 && pvp.currentTurnIdx >= pvp.turnOrder.length) pvp.currentTurnIdx = 0;
      }
      delete pvp.pendingActions[socket.id];
      delete pvp.players[socket.id];
      io.emit('pvp:state', getPvpSnapshot());
    }
    if (dungeon.players[socket.id]) {
      const idx = dungeon.turnOrder.indexOf(socket.id);
      if (idx !== -1) {
        dungeon.turnOrder.splice(idx, 1);
        if (dungeon.turnOrder.length > 0 && dungeon.currentTurnIdx >= dungeon.turnOrder.length) {
          dungeon.currentTurnIdx = 0;
        }
      }
      delete dungeon.players[socket.id];
      io.emit('dungeon:state', getDungeonSnapshot());
    }
    if (state.players[socket.id]) {
      const { name } = state.players[socket.id];
      delete state.players[socket.id];
      io.emit('host:state-update', getStateSnapshot());
      addLog(`"${name}" left`, 'info');
    }
  });
});

function getDungeonSnapshot() {
  const activeLen = dungeon.turnOrder.length;
  const currentTurnSocketId = dungeon.turnBased && activeLen > 0
    ? dungeon.turnOrder[dungeon.currentTurnIdx % activeLen]
    : null;
  const currentTurnPlayer = currentTurnSocketId ? dungeon.players[currentTurnSocketId] : null;
  return {
    width:       dungeon.width,
    height:      dungeon.height,
    players:     Object.values(dungeon.players),
    enemy:       dungeon.enemy,
    turnBased:   dungeon.turnBased,
    currentTurn: currentTurnPlayer ? currentTurnPlayer.name : null,
    mode:          dungeon.mode,
    timerEnabled:  dungeon.timerEnabled,
    timerSeconds:  dungeon.timerSeconds,
    clockSeconds:  dungeon.clockSeconds,
    timeLeft:      dungeon.timeLeft,
    pendingActions: dungeon.mode === 'clock' ? dungeon.pendingActions : {},
  };
}

function getStateSnapshot() {
  return {
    players:        Object.values(state.players),
    currentModule:  state.currentModule,
    currentDisplay: state.currentDisplay,
    dungeon: { width: dungeon.width, height: dungeon.height },
  };
}

// Enemy movement in free (non-turn-based) mode
setInterval(() => {
  if (!dungeon.turnBased && dungeon.enemy && Object.keys(dungeon.players).length > 0) {
    moveAndAttackEnemy();
    io.emit('dungeon:state', getDungeonSnapshot());
  }
}, 1500);

server.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
});

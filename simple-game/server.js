'use strict';

const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const QRCode  = require('qrcode');
const path    = require('path');
const os      = require('os'); // used to get local IP for QR code URL

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = 3001;

app.use(express.static(path.join(__dirname, 'public')));

// ── Colours assigned to players in join order ──────────────────────────────
const COLORS = ['#e96a6a','#f59e42','#4caf7d','#4a9de0','#9b8afb','#f06292','#26c6da','#a3c85a'];

// ── Game state ─────────────────────────────────────────────────────────────
// entities: { id, type:'player'|'enemy', name, x, y, socketId?, movement, color, alive }
// turnOrder: array of entity ids — host sets order during setup
let G = {
  phase:          'setup',
  grid:           Array.from({ length: 8 }, () => Array(10).fill(1)),
  entities:       [],
  turnOrder:      [],
  currentTurnIdx: 0,
  idCounter:      1,
};

let enemyTimer = null;

// ── Grid helpers ───────────────────────────────────────────────────────────
function cellOpen(x, y) {
  const row = G.grid[y];
  return row !== undefined && row[x] === 1;
}

function entityAt(x, y) {
  return G.entities.find(e => e.alive && e.x === x && e.y === y);
}

function byId(id) { return G.entities.find(e => e.id === id); }

// ── Snapshot sent to all clients ───────────────────────────────────────────
function snapshot() {
  const len   = G.turnOrder.length;
  const curId = G.phase === 'playing' && len > 0
    ? G.turnOrder[G.currentTurnIdx % len] : null;
  return {
    phase:          G.phase,
    grid:           G.grid,
    entities:       G.entities,
    turnOrder:      G.turnOrder,
    currentTurn:    curId,
  };
}

function broadcast() { io.emit('game:state', snapshot()); }

// ── Destroy an entity (bump kill or enemy kill) ────────────────────────────
function destroy(id) {
  const e = byId(id);
  if (!e || !e.alive) return;
  e.alive = false;

  const ti = G.turnOrder.indexOf(id);
  if (ti !== -1) {
    G.turnOrder.splice(ti, 1);
    if (G.currentTurnIdx > ti) G.currentTurnIdx--;
    if (G.currentTurnIdx >= G.turnOrder.length && G.turnOrder.length > 0)
      G.currentTurnIdx = 0;
  }

  if (e.socketId) io.to(e.socketId).emit('player:eliminated');
  io.emit('game:destroyed', { id, name: e.name });
}

// ── Turn progression ───────────────────────────────────────────────────────
function advanceTurn() {
  const len = G.turnOrder.length;
  if (!len) { broadcast(); return; }
  G.currentTurnIdx = (G.currentTurnIdx + 1) % len;
  broadcast();
  doTurn();
}

function doTurn() {
  const len = G.turnOrder.length;
  if (!len) return;
  const cur = byId(G.turnOrder[G.currentTurnIdx % len]);
  if (!cur || !cur.alive) { advanceTurn(); return; }

  if (cur.type === 'player') {
    if (cur.socketId) io.to(cur.socketId).emit('game:your-turn');
  } else {
    // Enemy acts after a visible 1.5 s delay so players can watch
    if (enemyTimer) clearTimeout(enemyTimer);
    enemyTimer = setTimeout(() => {
      runEnemy(cur);
      broadcast();
      advanceTurn();
    }, 1500);
  }
}

// ── Enemy AI: chaser — moves one step toward nearest player ───────────────
function runEnemy(enemy) {
  const players = G.entities.filter(e => e.type === 'player' && e.alive);
  if (!players.length) return;

  let target = players[0], best = Infinity;
  for (const p of players) {
    const d = Math.abs(p.x - enemy.x) + Math.abs(p.y - enemy.y);
    if (d < best) { best = d; target = p; }
  }

  const dx = Math.sign(target.x - enemy.x);
  const dy = Math.sign(target.y - enemy.y);

  // Try diagonal first, then cardinal fallbacks
  const candidates = [];
  if (dx !== 0 && dy !== 0) candidates.push([dx, dy]);
  if (dx !== 0) candidates.push([dx, 0]);
  if (dy !== 0) candidates.push([0, dy]);

  for (const [mx, my] of candidates) {
    const nx = enemy.x + mx, ny = enemy.y + my;
    if (!cellOpen(nx, ny)) continue;
    const blocker = entityAt(nx, ny);
    if (blocker) {
      if (blocker.type === 'player') { destroy(blocker.id); enemy.x = nx; enemy.y = ny; }
      // don't move into another enemy
    } else {
      enemy.x = nx; enemy.y = ny;
    }
    break;
  }
}

// ── Player move handler ────────────────────────────────────────────────────
function applyMove(socketId, dir) {
  if (G.phase !== 'playing') return;
  const player = G.entities.find(e => e.socketId === socketId && e.alive && e.type === 'player');
  if (!player) return;

  const len = G.turnOrder.length;
  if (!len) return;
  if (G.turnOrder[G.currentTurnIdx % len] !== player.id) return; // not your turn

  const DIRS = {
    up:[0,-1], down:[0,1], left:[-1,0], right:[1,0],
    upleft:[-1,-1], upright:[1,-1], downleft:[-1,1], downright:[1,1],
  };
  const d = DIRS[dir];
  if (!d) return;

  const nx = player.x + d[0], ny = player.y + d[1];
  if (!cellOpen(nx, ny)) return; // blocked — don't spend the turn

  const blocker = entityAt(nx, ny);
  if (blocker) destroy(blocker.id); // bump kill
  player.x = nx;
  player.y = ny;

  advanceTurn();
}

// ── Socket events ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  socket.emit('game:state', snapshot());

  // ── Player ───
  socket.on('player:join', ({ name }) => {
    if (!name?.trim()) return;

    // Reconnect: reuse existing entity with same name that lost its socket
    const existing = G.entities.find(
      e => e.type === 'player' && e.name === name.trim() && !e.socketId
    );
    if (existing) {
      existing.socketId = socket.id;
      socket.emit('player:registered', { id: existing.id, color: existing.color });
      broadcast();
      return;
    }

    if (G.entities.find(e => e.socketId === socket.id)) return;

    const playerCount = G.entities.filter(e => e.type === 'player').length;
    const id  = G.idCounter++;
    const cols = G.grid[0]?.length || 10;
    const rows = G.grid.length;

    G.entities.push({
      id, type: 'player', name: name.trim(),
      x: Math.floor(cols / 2), y: Math.floor(rows / 2),
      socketId: socket.id, movement: 'cardinal',
      color: COLORS[playerCount % COLORS.length], alive: true,
    });
    G.turnOrder.push(id);

    socket.emit('player:registered', { id, color: COLORS[playerCount % COLORS.length] });
    broadcast();
  });

  socket.on('player:choose-movement', ({ movement }) => {
    const e = G.entities.find(p => p.socketId === socket.id);
    if (e) { e.movement = movement; broadcast(); }
  });

  socket.on('player:move', ({ dir }) => applyMove(socket.id, dir));

  // ── Host ───
  socket.on('host:set-grid', ({ width, height }) => {
    const w = Math.max(2, Math.min(30, +width  || 10));
    const h = Math.max(2, Math.min(30, +height || 8));
    G.grid = Array.from({ length: h }, () => Array(w).fill(1));
    for (const e of G.entities) { e.x = Math.min(e.x, w-1); e.y = Math.min(e.y, h-1); }
    broadcast();
  });

  socket.on('host:toggle-wall', ({ x, y }) => {
    if (!G.grid[y] || G.grid[y][x] === undefined) return;
    G.grid[y][x] = G.grid[y][x] === 2 ? 1 : 2;
    broadcast();
  });

  socket.on('host:place', ({ id, x, y }) => {
    const e = byId(id); if (e) { e.x = x; e.y = y; broadcast(); }
  });

  socket.on('host:add-enemy', () => {
    const id   = G.idCounter++;
    const cols = G.grid[0]?.length || 10;
    const rows = G.grid.length;
    G.entities.push({ id, type: 'enemy', name: `Enemy ${id}`,
      x: Math.max(0, cols-2), y: 1, alive: true });
    G.turnOrder.push(id);
    broadcast();
  });

  socket.on('host:remove', ({ id }) => {
    G.entities  = G.entities.filter(e => e.id !== id);
    G.turnOrder = G.turnOrder.filter(tid => tid !== id);
    if (G.currentTurnIdx >= G.turnOrder.length && G.turnOrder.length > 0)
      G.currentTurnIdx = 0;
    broadcast();
  });

  socket.on('host:set-turn-order', ({ order }) => {
    if (Array.isArray(order)) { G.turnOrder = order.map(Number); broadcast(); }
  });

  socket.on('host:start', () => {
    if (G.phase === 'playing') return;
    G.phase = 'playing';
    G.currentTurnIdx = 0;
    if (!G.turnOrder.length)
      G.turnOrder = G.entities.filter(e => e.alive).map(e => e.id);
    broadcast();
    io.emit('game:started');
    doTurn();
  });

  socket.on('host:reset', () => {
    if (enemyTimer) { clearTimeout(enemyTimer); enemyTimer = null; }
    G.phase = 'setup';
    G.currentTurnIdx = 0;
    for (const e of G.entities) e.alive = true;
    broadcast();
  });

  socket.on('disconnect', () => {
    const e = G.entities.find(p => p.socketId === socket.id);
    if (e) e.socketId = null;
    broadcast();
  });
});

// ── QR code for player join URL ────────────────────────────────────────────
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

app.get('/api/qr.svg', async (req, res) => {
  const host = req.headers.host || `${getLocalIP()}:${PORT}`;
  const url  = `http://${host}/player.html`;
  try {
    const svg = await QRCode.toString(url, { type: 'svg' });
    res.setHeader('Content-Type', 'image/svg+xml');
    res.send(svg);
  } catch { res.status(500).end(); }
});

app.get('/', (_, res) => res.redirect('/host.html'));

server.listen(PORT, () => {
  console.log(`\n  Host         →  http://${getLocalIP()}:${PORT}/host.html`);
  console.log(`  Display      →  http://${getLocalIP()}:${PORT}/display.html`);
  console.log(`  Player       →  http://${getLocalIP()}:${PORT}/player.html\n`);
});

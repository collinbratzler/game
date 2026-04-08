'use strict'; // why?

// Server Essentials
const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');

// JavaScript Essentials
const os         = require('os');
const fs         = require('fs');
const path       = require('path');

// Here we just have a QR code cause why not?
const QRCode     = require('qrcode');

const registry   = require('./engine/playerRegistry');
const arenaEng   = require('./engine/arenaEngine');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);
const PORT   = 3000;

// ── Session state ──────────────────────────────────────────────────────
// Non-player, non-arena data that lives at the server level.
const session = {
  currentModule:  'waiting', // these can be combined into one variable possibky referring to the name of the folder with a player.html and display.html 
  currentDisplay: 'waiting-display', // see above
  chatHistory:    [], // these are fine but not a big priority right now
  activityLog:    [], // im thinking of maybe removing this functionality for simplicity or having it live in its own module
};

const DISPLAY_MAP = { // with single variable, we wont need this anymore
  'waiting':          'waiting-display',
  'character-select': 'character-select-display',
  'arena':            'arena-display',
  'chat':             'chat-display',
};
function toDisplayModule(id) { return DISPLAY_MAP[id] || id; } // dont need this 

function addLog(message, type = 'info') { // remove (save for future module)
  const entry = { ts: Date.now(), message, type };
  session.activityLog.push(entry);
  if (session.activityLog.length > 200) session.activityLog.shift();
  io.emit('host:log-update', session.activityLog);
}

// ── Engine init ────────────────────────────────────────────────────────
arenaEng.init(io, registry, addLog);
arenaEng.startFreeModeInterval();

// ── State snapshots ────────────────────────────────────────────────────
function getStateSnapshot() {
  const a = arenaEng.arena;
  return {
    players:        registry.getAll().map(registry.toStateShape),
    currentModule:  session.currentModule,
    currentDisplay: session.currentDisplay,
    arena: {
      shape:    a.shape,
      width:    a.width,
      height:   a.height,
      pvp:      a.pvp,
      hasEnemy: a.hasEnemy,
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

app.get('/api/join-url', (_req, res) => {
  res.json({ url: `http://${getLocalIP()}:${PORT}/player.html` });
});

app.get('/api/qr.svg', async (_req, res) => {
  const url = `http://${getLocalIP()}:${PORT}/player.html`;
  const svg = await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#1a1a1a', light: '#f7f6f3' } });
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(svg);
});

app.get('/api/levels', (_req, res) => {
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

// ── Socket.io ──────────────────────────────────────────────────────────
io.on('connection', (socket) => {

  // ── Host ─────────────────────────────────────────────────────────────
  socket.on('host:request-state', () => {
    socket.emit('host:state-update', getStateSnapshot());
    socket.emit('host:log-update',   session.activityLog);
    socket.emit('arena:state',       arenaEng.getSnapshot());
  });

  socket.on('host:push', (moduleId) => {
    const displayId = toDisplayModule(moduleId);
    session.currentModule  = moduleId;
    session.currentDisplay = displayId;
    io.emit('player:load-module',  moduleId);
    io.emit('display:load-module', displayId);
    io.emit('host:state-update',   getStateSnapshot());
    addLog(`→ ${moduleId}`, 'action');
  });

  socket.on('host:send-minigame', ({ socketId, minigame }) => {
    const p = registry.get(socketId);
    if (!p) return;
    io.to(socketId).emit('player:load-module', minigame);
    addLog(`Sent "${minigame}" → ${p.name}`, 'minigame');
  });

  socket.on('host:send-minigame-all', ({ minigame }) => {
    const players = registry.getAll();
    if (players.length === 0) return;
    players.forEach(p => io.to(p.socketId).emit('player:load-module', minigame));
    addLog(`Sent "${minigame}" → all (${players.length})`, 'minigame');
  });

  socket.on('host:set-class', ({ socketId, playerClass }) => {
    arenaEng.handleSetClass(socketId, playerClass);
    io.emit('host:state-update', getStateSnapshot());
  });

  socket.on('host:arena-config', (opts) => {
    arenaEng.handleConfig(opts);
    io.emit('host:state-update', getStateSnapshot());
    const a = arenaEng.arena;
    addLog(`Arena: ${a.shape} ${a.width}×${a.height} pvp=${a.pvp} enemy=${a.hasEnemy}`, 'info');
  });

  socket.on('host:arena-mode',             (mode)   => arenaEng.handleMode(mode));
  socket.on('host:arena-timer-toggle',     ()       => arenaEng.handleTimerToggle());
  socket.on('host:arena-timer-set',        (opts)   => arenaEng.handleTimerSet(opts));
  socket.on('host:arena-reset',            ()       => arenaEng.handleReset(session.currentModule));
  socket.on('host:arena-set-enemy-spawns', (spawns) => arenaEng.handleSetEnemySpawns(spawns));

  socket.on('host:arena-load-level', (id) => {
    arenaEng.handleLoadLevel(id);
    io.emit('host:state-update', getStateSnapshot());
  });

  socket.on('host:arena-start', (opts) => {
    arenaEng.handleStart(opts);
  });

  // ── Minigame ──────────────────────────────────────────────────────────
  socket.on('minigame:complete', ({ name, game, result }) => {
    const p = registry.getByName(name);
    if (p) io.to(p.socketId).emit('player:load-module', session.currentModule);
    if (result.fail)         addLog(`${name} · ${game} · FALSE START`, 'result-bad');
    else if (result.timeout) addLog(`${name} · ${game} · TIMEOUT`,     'result-bad');
    else                     addLog(`${name} · ${game} · ${result.time}ms`, 'result-good');
  });

  // ── Chat ───────────────────────────────────────────────────────────────
  socket.on('chat:request-history', () => socket.emit('chat:history', session.chatHistory));
  socket.on('chat:message', ({ name, text }) => {
    if (!text?.trim() || !name) return;
    const msg = { name, text: text.trim(), ts: Date.now() };
    session.chatHistory.push(msg);
    if (session.chatHistory.length > 200) session.chatHistory.shift();
    io.emit('chat:message', msg);
  });

  // ── Character Select ───────────────────────────────────────────────────
  socket.on('character-select:ready', ({ playerClass, colorIndex, movementType, attackType }) => {
    const p = registry.get(socket.id);
    if (!p) return;
    registry.update(socket.id, {
      playerClass,
      colorIndex,
      boots:          movementType,  // 'cardinal' | 'diagonal' → boots slot
      weapon:         attackType,    // 'melee' | 'ranged' | 'area' | 'pierce' → weapon slot
      charSelectDone: true,
    });
    io.emit('host:state-update', getStateSnapshot());
    const updated = registry.get(socket.id);
    io.emit('character-select:player-ready', {
      name:         updated.name,
      playerClass,
      colorIndex,
      movementType,
      attackType,
    });
    addLog(`${updated.name}: ${playerClass} | ${movementType} | ${attackType}`, 'info');
  });

  // ── Arena ──────────────────────────────────────────────────────────────
  socket.on('arena:player-ready', ({ colorIndex, movementType, attackType }) => {
    const p = registry.get(socket.id);
    if (!p) return;
    registry.update(socket.id, {
      colorIndex:     colorIndex ?? p.colorIndex,
      boots:          movementType || 'cardinal',
      weapon:         attackType   || 'melee',
      charSelectDone: true,
    });
    io.emit('arena:state',       arenaEng.getSnapshot());
    io.emit('host:state-update', getStateSnapshot());
    addLog(`${p.name}: ready (${movementType} | ${attackType})`, 'info');
  });

  socket.on('arena:join',          (name) => arenaEng.handleJoin(socket.id, name));
  socket.on('arena:move',          (dir)  => arenaEng.handleMove(socket.id, dir));
  socket.on('arena:attack',        ()     => arenaEng.handleAttack(socket.id));
  socket.on('arena:request-state', ()     => socket.emit('arena:state', arenaEng.getSnapshot()));

  // ── Player ─────────────────────────────────────────────────────────────
  socket.on('player:join', (name) => {
    registry.create(socket.id, name);
    socket.emit('player:load-module', session.currentModule);
    io.emit('host:state-update', getStateSnapshot());
    if (session.currentModule === 'arena') {
      io.emit('arena:state', arenaEng.getSnapshot());
    }
    addLog(`"${name}" joined`, 'info');
  });

  // ── Disconnect ─────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    arenaEng.handleDisconnect(socket.id);  // clean up arena state first
    const p = registry.get(socket.id);
    if (p) {
      addLog(`"${p.name}" left`, 'info');
      registry.remove(socket.id);
      io.emit('host:state-update', getStateSnapshot());
    }
  });
});

// ── Start ──────────────────────────────────────────────────────────────
server.listen(PORT, () => console.log(`Server: http://localhost:${PORT}`));

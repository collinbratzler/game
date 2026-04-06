'use strict';

// ── Player Registry ────────────────────────────────────────────────────
// Single source of truth for all connected players.
// Replaces the old split between state.players (identity) and
// arena.players (position) — one record per socketId, always.

const _players = {};  // socketId → record

// Create a new player record with defaults.
function create(socketId, name) {
  _players[socketId] = {
    // Identity
    name,
    socketId,
    // Character
    playerClass:    'barbarian',
    colorIndex:     0,
    charSelectDone: false,
    // Equipment slot IDs (resolved through itemRegistry)
    weapon: 'melee',     // was attackType
    boots:  'cardinal',  // was movementType
    charm:  null,
    // Arena position — only meaningful when inArena === true
    inArena: false,
    x:       0,
    y:       0,
    lastDir: 'up',
  };
  return _players[socketId];
}

function get(socketId)   { return _players[socketId] || null; }
function has(socketId)   { return socketId in _players; }
function getAll()        { return Object.values(_players); }

function getByName(name) {
  return Object.values(_players).find(p => p.name === name) || null;
}

function getArenaPlayers() {
  return Object.values(_players).filter(p => p.inArena);
}

// Merge fields into an existing record.
function update(socketId, fields) {
  if (!_players[socketId]) return null;
  Object.assign(_players[socketId], fields);
  return _players[socketId];
}

function remove(socketId) {
  delete _players[socketId];
}

// ── Serialisation helpers ──────────────────────────────────────────────
// Shape sent in host:state-update — keeps legacy field names for the
// existing host.html UI (movementType / attackType).
function toStateShape(p) {
  return {
    name:           p.name,
    socketId:       p.socketId,
    playerClass:    p.playerClass,
    movementType:   p.boots,   // legacy name expected by host.html
    attackType:     p.weapon,  // legacy name expected by host.html
    colorIndex:     p.colorIndex ?? null,
    charSelectDone: p.charSelectDone,
  };
}

// Shape included in the players array of arena:state.
function toArenaShape(p) {
  return {
    name:       p.name,
    socketId:   p.socketId,
    x:          p.x,
    y:          p.y,
    colorIndex: p.colorIndex,
    lastDir:    p.lastDir,
  };
}

module.exports = {
  create,
  get,
  has,
  getAll,
  getByName,
  getArenaPlayers,
  update,
  remove,
  toStateShape,
  toArenaShape,
};

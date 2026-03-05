const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const GRID = 40;
const CELL = 20;
const TICK_MS = 120;
const FOOD_COUNT = 12;
const RESPAWN_MS = 3000;

const ADMIN_CODE = '479572';
const TOURNAMENT_LOBBY_MS = 5 * 60 * 1000;  // 5 min attesa
const TOURNAMENT_DURATION_MS = 10 * 60 * 1000; // 10 min partita

// ── HTTP ──────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  let url = req.url === '/' ? '/index.html' : req.url;
  const fp = path.join(__dirname, 'public', url);
  fs.readFile(fp, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const mime = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };
    res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'text/plain' });
    res.end(data);
  });
});

// ── Helpers ───────────────────────────────────────────────────
function rnd(n) { return Math.floor(Math.random() * n); }
const COLORS = ['#00ffcc','#ff4466','#ffdd00','#44aaff','#ff8800','#cc44ff','#00ff88','#ff2299','#00ccff','#ffaa00'];
let colorIdx = 0;
function nextColor() { return COLORS[(colorIdx++) % COLORS.length]; }

function randCell(occupied) {
  let pos, tries = 0;
  do {
    pos = { x: rnd(GRID), y: rnd(GRID) };
    tries++;
  } while (occupied(pos) && tries < 200);
  return pos;
}

function cellEq(a, b) { return a.x === b.x && a.y === b.y; }

function isOccupied(pos, players) {
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    for (const seg of p.body) if (cellEq(seg, pos)) return true;
  }
  return false;
}

// ── Tournament State ──────────────────────────────────────────
// phase: 'normal' | 'lobby' | 'active' | 'ended'
let tournament = {
  phase: 'normal',
  mode: null,        // 'kills' | 'length'
  lobbyEndsAt: 0,
  gameEndsAt: 0,
  winner: null,
  winnerName: null,
  winnerColor: null,
  endedAt: 0
};

// ── State ─────────────────────────────────────────────────────
let players = {};
let food = [];
let uid = 1;

function spawnFood() {
  while (food.length < FOOD_COUNT) {
    const pos = randCell(p => food.some(f => cellEq(f, p)) || isOccupied(p, players));
    food.push({ ...pos, value: Math.random() < 0.15 ? 3 : 1 });
  }
}
spawnFood();

function createSnake(id, name) {
  const head = { x: rnd(GRID - 4) + 2, y: rnd(GRID - 4) + 2 };
  return {
    id,
    name: (name || 'Snake').slice(0, 16),
    color: nextColor(),
    body: [head, { x: head.x - 1, y: head.y }, { x: head.x - 2, y: head.y }],
    dir: { x: 1, y: 0 },
    nextDir: { x: 1, y: 0 },
    alive: true,
    kills: 0,
    deaths: 0,
    respawnAt: 0,
    ws: null,
    score: 0,
    tournamentKills: 0,
    tournamentMaxLength: 3
  };
}

// ── WebSocket ─────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on('connection', ws => {
  const id = uid++;
  ws.playerId = id;

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    if (msg.type === 'join') {
      // During tournament lobby or active, player waits — send them current tournament state
      const p = createSnake(id, msg.name);
      p.ws = ws;
      players[id] = p;
      ws.send(JSON.stringify({ type: 'init', id, grid: GRID, cell: CELL, tournament: getTournamentInfo() }));

      // If tournament is in lobby phase, they join as waiting
      if (tournament.phase === 'lobby') {
        p.alive = false;
        p.respawnAt = tournament.lobbyEndsAt;
      }
    }

    if (msg.type === 'dir' && players[id] && players[id].alive) {
      const p = players[id];
      const d = msg.dir;
      if (d.x !== -p.dir.x || d.y !== -p.dir.y) {
        p.nextDir = d;
      }
    }

    // Admin: create tournament
    if (msg.type === 'admin_create_tournament') {
      if (msg.code !== ADMIN_CODE) {
        ws.send(JSON.stringify({ type: 'admin_error', msg: 'Codice errato!' }));
        return;
      }
      if (tournament.phase !== 'normal') {
        ws.send(JSON.stringify({ type: 'admin_error', msg: 'Torneo già in corso!' }));
        return;
      }
      ws.send(JSON.stringify({ type: 'admin_ok' }));
    }

    if (msg.type === 'admin_start_tournament') {
      if (msg.code !== ADMIN_CODE) return;
      if (!['kills','length'].includes(msg.mode)) return;
      if (tournament.phase !== 'normal') return;

      startTournamentLobby(msg.mode);
    }
  });

  ws.on('close', () => { delete players[id]; });
  ws.on('error', () => { delete players[id]; });
});

// ── Tournament Logic ──────────────────────────────────────────
function getTournamentInfo() {
  return {
    phase: tournament.phase,
    mode: tournament.mode,
    lobbyEndsAt: tournament.lobbyEndsAt,
    gameEndsAt: tournament.gameEndsAt,
    winner: tournament.winner,
    winnerName: tournament.winnerName,
    winnerColor: tournament.winnerColor
  };
}

function startTournamentLobby(mode) {
  tournament.phase = 'lobby';
  tournament.mode = mode;
  tournament.lobbyEndsAt = Date.now() + TOURNAMENT_LOBBY_MS;
  tournament.winner = null;
  tournament.winnerName = null;
  tournament.winnerColor = null;

  // Freeze all current players (alive=false, they wait)
  for (const p of Object.values(players)) {
    p.alive = false;
    p.respawnAt = tournament.lobbyEndsAt;
    p.kills = 0;
    p.deaths = 0;
    p.score = 0;
    p.tournamentKills = 0;
    p.tournamentMaxLength = 3;
  }

  food = [];
  spawnFood();

  broadcast({ type: 'tournament_lobby', mode, endsAt: tournament.lobbyEndsAt });

  // Schedule tournament start
  setTimeout(() => {
    startTournamentActive();
  }, TOURNAMENT_LOBBY_MS);
}

function startTournamentActive() {
  if (tournament.phase !== 'lobby') return;
  tournament.phase = 'active';
  tournament.gameEndsAt = Date.now() + TOURNAMENT_DURATION_MS;

  // Spawn all connected players
  for (const p of Object.values(players)) {
    const head = randCell(pos => buildOccupied().has(`${pos.x},${pos.y}`));
    p.body = [head, { x: head.x - 1, y: head.y }, { x: head.x - 2, y: head.y }];
    p.dir = { x: 1, y: 0 };
    p.nextDir = { x: 1, y: 0 };
    p.alive = true;
    p.kills = 0;
    p.deaths = 0;
    p.score = 0;
    p.tournamentKills = 0;
    p.tournamentMaxLength = 3;
  }

  food = [];
  spawnFood();

  broadcast({ type: 'tournament_start', mode: tournament.mode, endsAt: tournament.gameEndsAt });

  // Schedule tournament end
  setTimeout(() => {
    endTournament();
  }, TOURNAMENT_DURATION_MS);
}

function endTournament() {
  if (tournament.phase !== 'active') return;
  tournament.phase = 'ended';

  // Find winner
  let best = null;
  let bestVal = -1;
  for (const p of Object.values(players)) {
    let val = tournament.mode === 'kills' ? p.tournamentKills : p.tournamentMaxLength;
    if (val > bestVal) {
      bestVal = val;
      best = p;
    }
  }

  tournament.winner = best ? best.id : null;
  tournament.winnerName = best ? best.name : null;
  tournament.winnerColor = best ? best.color : null;
  tournament.endedAt = Date.now();

  broadcast({
    type: 'tournament_end',
    winner: tournament.winner,
    winnerName: tournament.winnerName,
    winnerColor: tournament.winnerColor,
    mode: tournament.mode
  });

  // After 15 seconds return to normal
  setTimeout(() => {
    resetToNormal();
  }, 15000);
}

function resetToNormal() {
  tournament.phase = 'normal';
  tournament.mode = null;
  tournament.winner = null;
  tournament.winnerName = null;
  tournament.winnerColor = null;

  // Reset all players normally
  for (const p of Object.values(players)) {
    const head = randCell(pos => buildOccupied().has(`${pos.x},${pos.y}`));
    p.body = [head, { x: head.x - 1, y: head.y }, { x: head.x - 2, y: head.y }];
    p.dir = { x: 1, y: 0 };
    p.nextDir = { x: 1, y: 0 };
    p.alive = true;
    p.kills = 0;
    p.deaths = 0;
    p.score = 0;
    p.tournamentKills = 0;
    p.tournamentMaxLength = 3;
  }

  food = [];
  spawnFood();

  broadcast({ type: 'tournament_reset' });
}

// ── Game tick ─────────────────────────────────────────────────
function broadcast(data) {
  const s = JSON.stringify(data);
  for (const p of Object.values(players)) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
}

function buildOccupied() {
  const set = new Set();
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    for (const seg of p.body) set.add(`${seg.x},${seg.y}`);
  }
  return set;
}

setInterval(() => {
  const now = Date.now();

  // During lobby phase — no movement, just wait
  if (tournament.phase === 'lobby') {
    broadcast({
      type: 'state',
      players: Object.values(players).map(p => ({
        id: p.id, name: p.name, color: p.color,
        body: p.body, alive: false,
        kills: p.kills, deaths: p.deaths,
        score: p.score, respawnAt: p.respawnAt,
        dir: p.dir, tournamentKills: p.tournamentKills,
        tournamentMaxLength: p.tournamentMaxLength
      })),
      food,
      tournament: getTournamentInfo()
    });
    return;
  }

  // Normal respawn (not during lobby)
  for (const p of Object.values(players)) {
    if (!p.alive && now >= p.respawnAt) {
      // During active tournament, no respawn — stay dead
      if (tournament.phase === 'active') continue;
      const head = randCell(pos => buildOccupied().has(`${pos.x},${pos.y}`));
      p.body = [head, { x: head.x - 1, y: head.y }, { x: head.x - 2, y: head.y }];
      p.dir = { x: 1, y: 0 };
      p.nextDir = { x: 1, y: 0 };
      p.alive = true;
      p.score = 0;
    }
  }

  // Move
  const newHeads = {};
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    p.dir = p.nextDir;
    const head = p.body[0];
    let nx = (head.x + p.dir.x + GRID) % GRID;
    let ny = (head.y + p.dir.y + GRID) % GRID;
    newHeads[p.id] = { x: nx, y: ny };
  }

  // Collisions
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    const nh = newHeads[p.id];

    for (let i = 0; i < p.body.length - 1; i++) {
      if (cellEq(nh, p.body[i])) {
        p.alive = false; p.deaths++; p.respawnAt = now + RESPAWN_MS;
        break;
      }
    }
    if (!p.alive) continue;

    for (const other of Object.values(players)) {
      if (other.id === p.id || !other.alive) continue;
      for (let i = 0; i < other.body.length; i++) {
        if (cellEq(nh, other.body[i])) {
          p.alive = false; p.deaths++; p.respawnAt = now + RESPAWN_MS;
          if (i === 0) {
            other.alive = false; other.deaths++; other.respawnAt = now + RESPAWN_MS;
          } else {
            other.kills++;
            if (tournament.phase === 'active') other.tournamentKills++;
          }
          break;
        }
      }
      if (!p.alive) break;
      if (other.id !== p.id && newHeads[other.id] && cellEq(nh, newHeads[other.id])) {
        p.alive = false; p.deaths++; p.respawnAt = now + RESPAWN_MS;
        other.alive = false; other.deaths++; other.respawnAt = now + RESPAWN_MS;
      }
    }
  }

  // Move + eat food
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    const nh = newHeads[p.id];
    p.body.unshift(nh);

    const fi = food.findIndex(f => cellEq(f, nh));
    if (fi !== -1) {
      const val = food[fi].value;
      food.splice(fi, 1);
      p.score += val;
      for (let v = 1; v < val; v++) {
        p.body.push({ ...p.body[p.body.length - 1] });
      }
    } else {
      p.body.pop();
    }

    // Track tournament max length
    if (tournament.phase === 'active') {
      if (p.body.length > p.tournamentMaxLength) {
        p.tournamentMaxLength = p.body.length;
      }
    }
  }

  spawnFood();

  broadcast({
    type: 'state',
    players: Object.values(players).map(p => ({
      id: p.id, name: p.name, color: p.color,
      body: p.body, alive: p.alive,
      kills: p.kills, deaths: p.deaths,
      score: p.score, respawnAt: p.respawnAt,
      dir: p.dir, tournamentKills: p.tournamentKills,
      tournamentMaxLength: p.tournamentMaxLength
    })),
    food,
    tournament: getTournamentInfo()
  });

}, TICK_MS);

server.listen(PORT, () => console.log(`🐍 Snake Arena on port ${PORT}`));

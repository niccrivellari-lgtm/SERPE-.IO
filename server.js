const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const GRID = 40;
const TICK_MS = 120;
const FOOD_COUNT = 12;
const RESPAWN_MS = 3000;

const ADMIN_CODE = '479572';
const PRE_REGISTRATION_MS = 30 * 60 * 1000; // 30 min prima → apre registrazione
const TOURNAMENT_DURATION_MS = 10 * 60 * 1000;
const WINNER_BOARD_MS = 15 * 60 * 1000;

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

function randCell(occupiedFn) {
  let pos, tries = 0;
  do { pos = { x: rnd(GRID), y: rnd(GRID) }; tries++; } while (occupiedFn(pos) && tries < 200);
  return pos;
}
function cellEq(a, b) { return a.x === b.x && a.y === b.y; }
function buildOccupied() {
  const set = new Set();
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    for (const seg of p.body) set.add(`${seg.x},${seg.y}`);
  }
  return set;
}

// ── Tournament State ──────────────────────────────────────────
// phase: 'normal' | 'scheduled' | 'registration' | 'active' | 'ended'
//
// FLUSSO:
//  normal → (admin schedula) → scheduled
//  scheduled → (30 min prima) → registration  [gioco normale continua, ci si iscrive]
//  registration → (ora X) → active            [solo iscritti giocano, ≤1 = annullato]
//  active → (fine / 0 giocatori) → ended
//  ended → (15 min) → normal
let tournament = {
  phase: 'normal',
  mode: null,
  scheduledAt: 0,
  registrationAt: 0,
  gameEndsAt: 0,
  winnerBoard: [],
  winnerBoardExpiresAt: 0,
  registeredIds: new Set(),
  _timers: []
};

function clearTournamentTimers() {
  for (const t of tournament._timers) clearTimeout(t);
  tournament._timers = [];
}
function addTimer(fn, delay) {
  if (delay < 0) delay = 0;
  const t = setTimeout(fn, delay);
  tournament._timers.push(t);
}

// ── Game State ────────────────────────────────────────────────
let players = {};
let food = [];
let uid = 1;

function spawnFood() {
  while (food.length < FOOD_COUNT) {
    const pos = randCell(p => food.some(f => cellEq(f, p)));
    food.push({ ...pos, value: Math.random() < 0.15 ? 3 : 1 });
  }
}
spawnFood();

function createSnake(id, name) {
  const head = { x: rnd(GRID - 4) + 2, y: rnd(GRID - 4) + 2 };
  return {
    id, name: (name || 'Snake').slice(0, 16),
    color: nextColor(),
    body: [head, { x: head.x - 1, y: head.y }, { x: head.x - 2, y: head.y }],
    dir: { x: 1, y: 0 }, nextDir: { x: 1, y: 0 },
    alive: true, kills: 0, deaths: 0,
    respawnAt: 0, ws: null, score: 0,
    tournamentKills: 0, tournamentMaxLength: 3,
    inTournamentWaitlist: false
  };
}

function serializePlayer(p) {
  return {
    id: p.id, name: p.name, color: p.color,
    body: p.body, alive: p.alive,
    kills: p.kills, deaths: p.deaths,
    score: p.score, respawnAt: p.respawnAt,
    dir: p.dir, tournamentKills: p.tournamentKills,
    tournamentMaxLength: p.tournamentMaxLength,
    inTournamentWaitlist: p.inTournamentWaitlist
  };
}

function getTournamentInfo() {
  return {
    phase: tournament.phase,
    mode: tournament.mode,
    scheduledAt: tournament.scheduledAt,
    registrationAt: tournament.registrationAt,
    gameEndsAt: tournament.gameEndsAt,
    winnerBoard: tournament.winnerBoard,
    winnerBoardExpiresAt: tournament.winnerBoardExpiresAt,
    registeredCount: tournament.registeredIds.size
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

    // ── JOIN ──────────────────────────────────────────────────
    if (msg.type === 'join') {
      const name = (msg.name || '').trim();

      // Check anonimo (polling stato torneo dalla lobby)
      if (name === '__check__') {
        ws.send(JSON.stringify({ type: 'tournament_status', tournament: getTournamentInfo() }));
        return;
      }

      if (!name) {
        ws.send(JSON.stringify({ type: 'join_rejected', reason: 'no_name' }));
        return;
      }

      // Torneo ATTIVO: solo iscritti possono entrare, gli altri aspettano
      if (tournament.phase === 'active') {
        ws.send(JSON.stringify({ type: 'join_rejected', reason: 'tournament_active' }));
        return;
      }

      // In tutte le altre fasi (normal, scheduled, registration, ended) si può giocare
      const p = createSnake(id, name);
      p.ws = ws;
      players[id] = p;

      // Fase registration → auto-iscrizione alla lista d'attesa
      if (tournament.phase === 'registration') {
        p.inTournamentWaitlist = true;
        tournament.registeredIds.add(id);
        console.log(`[TORNEO] Auto-iscritto alla waitlist: ${name} (totale: ${tournament.registeredIds.size})`);
      }

      ws.send(JSON.stringify({
        type: 'init', id, grid: GRID,
        tournament: getTournamentInfo()
      }));
    }

    // ── DIR ───────────────────────────────────────────────────
    if (msg.type === 'dir' && players[id] && players[id].alive) {
      const p = players[id];
      const d = msg.dir;
      if (d.x !== -p.dir.x || d.y !== -p.dir.y) p.nextDir = d;
    }

    // ── ADMIN: PROGRAMMA TORNEO ───────────────────────────────
    if (msg.type === 'admin_schedule_tournament') {
      if (msg.code !== ADMIN_CODE) {
        ws.send(JSON.stringify({ type: 'admin_error', msg: 'Codice errato!' })); return;
      }
      if (tournament.phase !== 'normal') {
        ws.send(JSON.stringify({ type: 'admin_error', msg: 'Torneo già programmato o in corso!' })); return;
      }
      if (!['survival', 'length'].includes(msg.mode)) {
        ws.send(JSON.stringify({ type: 'admin_error', msg: 'Modalità non valida!' })); return;
      }
      const scheduledAt = Number(msg.scheduledAt);
      if (!scheduledAt || scheduledAt <= Date.now() + 60000) {
        ws.send(JSON.stringify({ type: 'admin_error', msg: 'Orario non valido!' })); return;
      }
      scheduleTournament(msg.mode, scheduledAt);
      ws.send(JSON.stringify({ type: 'admin_ok', scheduledAt }));
    }

    // ── ADMIN: CANCELLA ───────────────────────────────────────
    if (msg.type === 'admin_cancel_tournament') {
      if (msg.code !== ADMIN_CODE) {
        ws.send(JSON.stringify({ type: 'admin_error', msg: 'Codice errato!' })); return;
      }
      if (tournament.phase === 'normal') {
        ws.send(JSON.stringify({ type: 'admin_error', msg: 'Nessun torneo da cancellare!' })); return;
      }
      if (tournament.phase === 'active') {
        ws.send(JSON.stringify({ type: 'admin_error', msg: 'Torneo già in corso!' })); return;
      }
      cancelTournament();
      ws.send(JSON.stringify({ type: 'admin_ok' }));
    }
  });

  ws.on('close', () => {
    if (players[id]) {
      tournament.registeredIds.delete(id);
      delete players[id];
    }
  });
  ws.on('error', () => {
    if (players[id]) {
      tournament.registeredIds.delete(id);
      delete players[id];
    }
  });
});

// ── Tournament Logic ──────────────────────────────────────────
function scheduleTournament(mode, scheduledAt) {
  clearTournamentTimers();
  const now = Date.now();

  tournament.phase = 'scheduled';
  tournament.mode = mode;
  tournament.scheduledAt = scheduledAt;
  tournament.registrationAt = scheduledAt - PRE_REGISTRATION_MS;
  tournament.gameEndsAt = 0;
  tournament.winnerBoard = [];
  tournament.winnerBoardExpiresAt = 0;
  tournament.registeredIds = new Set();

  broadcast({ type: 'tournament_scheduled', tournament: getTournamentInfo() });

  const msToRegistration = tournament.registrationAt - now;
  const msToStart = scheduledAt - now;

  if (msToRegistration > 0) {
    addTimer(() => openRegistration(), msToRegistration);
  } else {
    // Già nella finestra dei 30 min → apri registrazione subito
    setTimeout(() => openRegistration(), 100);
  }

  addTimer(() => startTournamentActive(), msToStart);
  console.log(`[TORNEO] Programmato "${mode}" per ${new Date(scheduledAt).toLocaleString('it-IT')}`);
}

function cancelTournament() {
  clearTournamentTimers();
  tournament.phase = 'normal';
  tournament.mode = null;
  tournament.scheduledAt = 0;
  tournament.registrationAt = 0;
  tournament.winnerBoard = [];
  tournament.winnerBoardExpiresAt = 0;
  tournament.registeredIds = new Set();
  for (const p of Object.values(players)) p.inTournamentWaitlist = false;
  broadcast({ type: 'tournament_cancelled' });
  console.log('[TORNEO] Cancellato.');
}

// Apre la finestra di registrazione (30 min prima del torneo)
// Il gioco normale continua — chi è dentro viene auto-iscritto,
// chi entra ora viene iscritto automaticamente
function openRegistration() {
  if (tournament.phase !== 'scheduled') return;
  tournament.phase = 'registration';

  // Chi è già connesso: auto-iscritto
  for (const p of Object.values(players)) {
    p.inTournamentWaitlist = true;
    tournament.registeredIds.add(p.id);
  }

  broadcast({ type: 'tournament_registration_open', tournament: getTournamentInfo() });
  console.log(`[TORNEO] Registrazione aperta. Iscritti auto: ${tournament.registeredIds.size}`);
}

function startTournamentActive() {
  if (tournament.phase !== 'registration' && tournament.phase !== 'scheduled') return;

  const waitlisted = [...tournament.registeredIds];

  // ≤1 iscritto → annullamento automatico, si torna al gioco normale
  if (waitlisted.length <= 1) {
    console.log(`[TORNEO] Annullato: solo ${waitlisted.length} iscritto/i.`);
    broadcast({
      type: 'tournament_auto_cancelled',
      reason: 'not_enough_players',
      registeredCount: waitlisted.length
    });
    resetToNormal();
    return;
  }

  tournament.phase = 'active';
  tournament.gameEndsAt = tournament.mode === 'length' ? Date.now() + TOURNAMENT_DURATION_MS : 0;

  // Espelli chi NON era iscritto
  for (const p of Object.values(players)) {
    if (!waitlisted.includes(p.id)) {
      if (p.ws && p.ws.readyState === 1) {
        try { p.ws.close(1000, 'tournament_active'); } catch {}
      }
      delete players[p.id];
    }
  }

  // Reset campo e stats per gli iscritti
  food = [];
  spawnFood();
  for (const p of Object.values(players)) {
    const head = randCell(pos => buildOccupied().has(`${pos.x},${pos.y}`));
    p.body = [head, { x: head.x - 1, y: head.y }, { x: head.x - 2, y: head.y }];
    p.dir = { x: 1, y: 0 }; p.nextDir = { x: 1, y: 0 };
    p.alive = true; p.score = 0;
    p.tournamentKills = 0; p.tournamentMaxLength = 3;
  }

  broadcast({ type: 'tournament_start', tournament: getTournamentInfo() });
  console.log(`[TORNEO] INIZIATO! Modalità: ${tournament.mode}, giocatori: ${Object.keys(players).length}`);

  if (tournament.mode === 'length') {
    addTimer(() => endTournament(), TOURNAMENT_DURATION_MS);
  }
}

function endTournament() {
  if (tournament.phase !== 'active') return;
  tournament.phase = 'ended';

  const all = Object.values(players);
  let sorted;
  if (tournament.mode === 'survival') {
    sorted = [...all].sort((a, b) => {
      if (a.alive && !b.alive) return -1;
      if (!a.alive && b.alive) return 1;
      return (b.tournamentKills || 0) - (a.tournamentKills || 0);
    });
  } else {
    sorted = [...all].sort((a, b) => (b.tournamentMaxLength || 3) - (a.tournamentMaxLength || 3));
  }

  tournament.winnerBoard = sorted.slice(0, 10).map((p, i) => ({
    rank: i + 1,
    name: p.name,
    color: p.color,
    stat: tournament.mode === 'survival'
      ? `${p.tournamentKills || 0} kill`
      : `${p.tournamentMaxLength || 3} cells`
  }));
  tournament.winnerBoardExpiresAt = Date.now() + WINNER_BOARD_MS;

  const winner = sorted[0] || null;
  broadcast({
    type: 'tournament_end',
    winnerName: winner ? winner.name : null,
    winnerColor: winner ? winner.color : null,
    mode: tournament.mode,
    winnerBoard: tournament.winnerBoard,
    winnerBoardExpiresAt: tournament.winnerBoardExpiresAt
  });

  console.log(`[TORNEO] FINITO! Vincitore: ${winner ? winner.name : '???'}`);

  // Reset a normale dopo 15 min
  addTimer(() => resetToNormal(), WINNER_BOARD_MS);
}

function resetToNormal() {
  clearTournamentTimers();
  tournament.phase = 'normal';
  tournament.mode = null;
  tournament.scheduledAt = 0;
  tournament.registrationAt = 0;
  tournament.gameEndsAt = 0;
  tournament.winnerBoard = [];
  tournament.winnerBoardExpiresAt = 0;
  tournament.registeredIds = new Set();

  // Tutti i connessi tornano al gioco classico
  for (const p of Object.values(players)) {
    const head = randCell(pos => buildOccupied().has(`${pos.x},${pos.y}`));
    p.body = [head, { x: head.x - 1, y: head.y }, { x: head.x - 2, y: head.y }];
    p.dir = { x: 1, y: 0 }; p.nextDir = { x: 1, y: 0 };
    p.alive = true; p.kills = 0; p.deaths = 0; p.score = 0;
    p.tournamentKills = 0; p.tournamentMaxLength = 3;
    p.inTournamentWaitlist = false;
  }

  food = [];
  spawnFood();
  broadcast({ type: 'tournament_reset' });
  console.log('[TORNEO] Reset a gioco normale.');
}

// ── Broadcast ─────────────────────────────────────────────────
function broadcast(data) {
  const s = JSON.stringify(data);
  for (const p of Object.values(players)) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
}

// ── Game Tick ─────────────────────────────────────────────────
setInterval(() => {
  const now = Date.now();

  // scheduled / registration: gioco normale continua (players si muovono)
  // ended: nessun movimento, solo broadcast per mostrare overlay
  if (tournament.phase === 'ended') {
    if (Object.keys(players).length > 0) {
      broadcast({ type: 'state', players: Object.values(players).map(serializePlayer), food, tournament: getTournamentInfo() });
    }
    return;
  }

  // Auto-chiusura se torneo attivo e 0 giocatori
  if (tournament.phase === 'active' && Object.keys(players).length === 0) {
    console.log('[TORNEO] Nessun giocatore — torneo chiuso automaticamente.');
    endTournament();
    return;
  }

  // Respawn (non in survival attivo)
  for (const p of Object.values(players)) {
    if (!p.alive && now >= p.respawnAt) {
      if (tournament.phase === 'active' && tournament.mode === 'survival') continue;
      const head = randCell(pos => buildOccupied().has(`${pos.x},${pos.y}`));
      p.body = [head, { x: head.x - 1, y: head.y }, { x: head.x - 2, y: head.y }];
      p.dir = { x: 1, y: 0 }; p.nextDir = { x: 1, y: 0 };
      p.alive = true; p.score = 0;
    }
  }

  // Move
  const newHeads = {};
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    p.dir = p.nextDir;
    const head = p.body[0];
    newHeads[p.id] = {
      x: (head.x + p.dir.x + GRID) % GRID,
      y: (head.y + p.dir.y + GRID) % GRID
    };
  }

  // Collisions
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    const nh = newHeads[p.id];
    for (let i = 0; i < p.body.length - 1; i++) {
      if (cellEq(nh, p.body[i])) {
        p.alive = false; p.deaths++; p.respawnAt = now + RESPAWN_MS; break;
      }
    }
    if (!p.alive) continue;
    for (const other of Object.values(players)) {
      if (other.id === p.id || !other.alive) continue;
      for (let i = 0; i < other.body.length; i++) {
        if (cellEq(nh, other.body[i])) {
          p.alive = false; p.deaths++; p.respawnAt = now + RESPAWN_MS;
          if (i === 0) { other.alive = false; other.deaths++; other.respawnAt = now + RESPAWN_MS; }
          else { other.kills++; if (tournament.phase === 'active') other.tournamentKills++; }
          break;
        }
      }
      if (!p.alive) break;
      if (newHeads[other.id] && cellEq(nh, newHeads[other.id])) {
        p.alive = false; p.deaths++; p.respawnAt = now + RESPAWN_MS;
        other.alive = false; other.deaths++; other.respawnAt = now + RESPAWN_MS;
      }
    }
  }

  // Move + eat
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    const nh = newHeads[p.id];
    p.body.unshift(nh);
    const fi = food.findIndex(f => cellEq(f, nh));
    if (fi !== -1) {
      const val = food[fi].value;
      food.splice(fi, 1);
      p.score += val;
      for (let v = 1; v < val; v++) p.body.push({ ...p.body[p.body.length - 1] });
    } else {
      p.body.pop();
    }
    if (tournament.phase === 'active' && p.body.length > p.tournamentMaxLength) {
      p.tournamentMaxLength = p.body.length;
    }
  }

  spawnFood();

  // Survival end check
  if (tournament.phase === 'active' && tournament.mode === 'survival') {
    const alive = Object.values(players).filter(p => p.alive);
    if (Object.keys(players).length > 1 && alive.length <= 1) {
      broadcast({ type: 'state', players: Object.values(players).map(serializePlayer), food, tournament: getTournamentInfo() });
      endTournament();
      return;
    }
  }

  broadcast({
    type: 'state',
    players: Object.values(players).map(serializePlayer),
    food, tournament: getTournamentInfo()
  });

}, TICK_MS);

server.listen(PORT, () => console.log(`🐍 Snake Arena on port ${PORT}`));

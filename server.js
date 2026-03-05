const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const GRID = 40;          // celle per riga/colonna
const CELL = 20;          // px per cella (usato solo dal client)
const TICK_MS = 120;      // velocità gioco (ms per step)
const FOOD_COUNT = 12;    // cibo sempre presente
const RESPAWN_MS = 3000;

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

// ── State ─────────────────────────────────────────────────────
let players = {};
let food = [];
let uid = 1;

function spawnFood() {
  while (food.length < FOOD_COUNT) {
    const pos = randCell(p => food.some(f => cellEq(f, p)) || isOccupied(p, players));
    food.push({ ...pos, value: Math.random() < 0.15 ? 3 : 1 }); // 15% cibo speciale vale 3
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
    score: 0
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
      const p = createSnake(id, msg.name);
      p.ws = ws;
      players[id] = p;
      ws.send(JSON.stringify({ type: 'init', id, grid: GRID, cell: CELL }));
    }

    if (msg.type === 'dir' && players[id] && players[id].alive) {
      const p = players[id];
      const d = msg.dir;
      // Impedisci inversione a 180°
      if (d.x !== -p.dir.x || d.y !== -p.dir.y) {
        p.nextDir = d;
      }
    }
  });

  ws.on('close', () => { delete players[id]; });
  ws.on('error', () => { delete players[id]; });
});

// ── Game tick ─────────────────────────────────────────────────
function broadcast(data) {
  const s = JSON.stringify(data);
  for (const p of Object.values(players)) {
    if (p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
}

// Raccoglie tutte le celle occupate come Set di stringhe
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

  // Respawn
  for (const p of Object.values(players)) {
    if (!p.alive && now >= p.respawnAt) {
      const head = randCell(pos => buildOccupied().has(`${pos.x},${pos.y}`));
      p.body = [head, { x: head.x - 1, y: head.y }, { x: head.x - 2, y: head.y }];
      p.dir = { x: 1, y: 0 };
      p.nextDir = { x: 1, y: 0 };
      p.alive = true;
      p.score = 0;
    }
  }

  // Muovi tutti i serpenti vivi
  const newHeads = {}; // id → nuova testa

  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    p.dir = p.nextDir;
    const head = p.body[0];
    let nx = (head.x + p.dir.x + GRID) % GRID;
    let ny = (head.y + p.dir.y + GRID) % GRID;
    newHeads[p.id] = { x: nx, y: ny };
  }

  // Controlla collisioni
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    const nh = newHeads[p.id];

    // vs muri — wrapping già fatto sopra (nessun muro)
    // vs se stesso (escludi coda che si sposterà)
    for (let i = 0; i < p.body.length - 1; i++) {
      if (cellEq(nh, p.body[i])) {
        p.alive = false; p.deaths++; p.respawnAt = now + RESPAWN_MS;
        break;
      }
    }
    if (!p.alive) continue;

    // vs altri serpenti
    for (const other of Object.values(players)) {
      if (other.id === p.id || !other.alive) continue;
      // vs corpo dell'altro
      for (let i = 0; i < other.body.length; i++) {
        if (cellEq(nh, other.body[i])) {
          p.alive = false; p.deaths++; p.respawnAt = now + RESPAWN_MS;
          // chi possiede quel segmento ottiene il kill
          if (i === 0) {
            // testa contro testa → entrambi morti
            other.alive = false; other.deaths++; other.respawnAt = now + RESPAWN_MS;
          } else {
            other.kills++;
          }
          break;
        }
      }
      if (!p.alive) break;
      // vs nuova testa dell'altro (stesso frame)
      if (other.id !== p.id && newHeads[other.id] && cellEq(nh, newHeads[other.id])) {
        p.alive = false; p.deaths++; p.respawnAt = now + RESPAWN_MS;
        other.alive = false; other.deaths++; other.respawnAt = now + RESPAWN_MS;
      }
    }
  }

  // Applica movimento e mangia cibo
  for (const p of Object.values(players)) {
    if (!p.alive) continue;
    const nh = newHeads[p.id];
    p.body.unshift(nh);

    // Controlla cibo
    const fi = food.findIndex(f => cellEq(f, nh));
    if (fi !== -1) {
      const val = food[fi].value;
      food.splice(fi, 1);
      p.score += val;
      // Cresci: non rimuovere la coda (aggiungi segmenti extra per cibo speciale)
      for (let v = 1; v < val; v++) {
        p.body.push({ ...p.body[p.body.length - 1] });
      }
      // Non togliere la coda = serpente cresce
    } else {
      p.body.pop(); // nessun cibo → rimane uguale
    }
  }

  // Rispawn cibo
  spawnFood();

  // Snapshot
  broadcast({
    type: 'state',
    players: Object.values(players).map(p => ({
      id: p.id, name: p.name, color: p.color,
      body: p.body, alive: p.alive,
      kills: p.kills, deaths: p.deaths,
      score: p.score, respawnAt: p.respawnAt,
      dir: p.dir
    })),
    food
  });

}, TICK_MS);

server.listen(PORT, () => console.log(`🐍 Snake Arena on port ${PORT}`));

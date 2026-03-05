# 🐍 Snake Arena — Multiplayer Battle Royale

Gioco Snake multiplayer in tempo reale. Tutti nella stessa mappa, lobby unica globale.  
Mangia il cibo per crescere. Tocca un altro serpente = muori. Fai kill tagliando la strada agli avversari!

## 🎮 Come si gioca

| Tasto | Azione |
|-------|--------|
| `W` / `↑` | Su |
| `S` / `↓` | Giù |
| `A` / `←` | Sinistra |
| `D` / `→` | Destra |
| **Swipe** | Funziona anche da mobile! |

- 🟢 Pallini verdi = +1 punto, cresci di 1
- ⭐ Stelle gialle = +3 punti, cresci di 3
- 💀 Tocca un altro serpente → muori, respawn dopo 3 secondi
- 💥 Testa contro testa → entrambi morti

---

## 🚀 Deploy GRATIS su Railway (5 minuti)

1. Crea un repo su **github.com** e carica questi file
2. Vai su **[railway.app](https://railway.app)** → login con GitHub
3. **New Project → Deploy from GitHub Repo** → seleziona il repo
4. Aspetta il build (~1 min)
5. **Settings → Networking → Generate Domain**
6. Condividi il link — tutti possono giocare!

---

## 🚀 Alternativa: Render.com (gratis)

1. **[render.com](https://render.com)** → New Web Service → collega GitHub
2. Build Command: `npm install`
3. Start Command: `node server.js`
4. Plan: **Free** → Create

---

## 📁 File

```
snake-arena/
├── server.js        ← Game server (Node.js + WebSocket)
├── package.json     ← Dipendenze
├── .gitignore
└── public/
    └── index.html   ← Client completo
```

## ⚙️ Variabili d'ambiente

| Variabile | Default | Descrizione |
|-----------|---------|-------------|
| `PORT` | `3000` | Porta server |

## 🛠 Locale

```bash
npm install
node server.js
# Apri http://localhost:3000
```

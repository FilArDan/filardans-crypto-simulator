const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { initDb } = require('./db');
const { tick } = require('./game/market');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
app.set('io', io);

// ── Разрешаем встраивание в iframe (нужно для Foundry-модуля) ────────────────
// Убираем X-Frame-Options и прописываем CSP frame-ancestors *,
// чтобы окно Foundry могло открыть сайт через <iframe>.
app.use((req, res, next) => {
  // Снимаем запрет на iframe
  res.removeHeader('X-Frame-Options');
  // Разрешаем встраивание с любого источника (в т.ч. localhost Foundry)
  res.setHeader(
    'Content-Security-Policy',
    "frame-ancestors *; default-src 'self' 'unsafe-inline' 'unsafe-eval' ws: wss: data: blob:;"
  );
  // Для cross-origin cookie внутри iframe
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// ── Rate Limiter (без внешних зависимостей) ───────────────────────────────────
const WINDOW_MS   = 10_000;
const LIMIT_WRITE = 20;
const LIMIT_READ  = 60;
const counters    = new Map();

function getIp(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
}

function isWriteRoute(path) {
  return /^\/api\/(trade|loan$|repay|transfer)/.test(path);
}

function rateLimiter(req, res, next) {
  const ip    = getIp(req);
  const limit = isWriteRoute(req.path) ? LIMIT_WRITE : LIMIT_READ;
  const now   = Date.now();
  let   entry = counters.get(ip);

  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + WINDOW_MS };
    counters.set(ip, entry);
  }

  entry.count++;

  if (entry.count > limit) {
    const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
    res.set('Retry-After', retryAfter);
    return res.status(429).json({
      error: `Слишком много запросов. Подожди ${retryAfter}с.`
    });
  }

  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of counters) {
    if (now > entry.resetAt) counters.delete(ip);
  }
}, 30_000);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SECRET || 'crypto-dev-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 8 * 60 * 60 * 1000,
    // sameSite: 'none' + secure нужны для cookie внутри cross-origin iframe
    sameSite: 'none',
    secure: process.env.NODE_ENV === 'production',
  }
}));

app.use('/api',  rateLimiter);
app.use('/auth', rateLimiter);

app.use('/auth', require('./routes/auth'));
app.use('/api',  require('./routes/game'));

// ── Пауза ─────────────────────────────────────────────────────────────────────
let paused = false;
app.set('isPaused',   () => paused);
app.set('setPaused',  (val) => {
  paused = !!val;
  io.emit('pauseChanged', { paused });
});

const marketTick = () => { if (!paused) tick(io); };
app.set('marketTick', marketTick);

let tickSpeedMs = 25000;
let marketTimer = setInterval(marketTick, tickSpeedMs);

app.set('setTickSpeed', (ms) => {
  clearInterval(marketTimer);
  tickSpeedMs = ms;
  marketTimer = setInterval(marketTick, tickSpeedMs);
  io.emit('tickSpeedChanged', { ms: tickSpeedMs });
});
app.set('getTickSpeed', () => tickSpeedMs);

io.on('connection', socket => {
  console.log('[socket] подключился:', socket.id);
  socket.emit('tickSpeedChanged', { ms: tickSpeedMs });
  socket.emit('pauseChanged', { paused });
});

const PORT = process.env.PORT || 3000;
initDb().then(() => {
  httpServer.listen(PORT, () => {
    console.log('\n✅ Сервер запущен: http://localhost:' + PORT);
    console.log('   Игроки: http://localhost:' + PORT + '/');
    console.log('   Админ:  http://localhost:' + PORT + '/admin.html\n');
  });
}).catch(err => {
  console.error('Ошибка запуска:', err);
});

require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const NeDB = require('@seald-io/nedb');
const { initDb } = require('./db');
const { tick } = require('./game/market');

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
app.set('io', io);

// ── Разрешаем встраивание в iframe (нужно для Foundry-модуля) ─────────────────
app.use((req, res, next) => {
  res.removeHeader('X-Frame-Options');
  res.setHeader('Content-Security-Policy', "frame-ancestors *;");
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

// ── NeDB Session Store ────────────────────────────────────────────────────────
// Хранит сессии в файле — переживают перезапуск сервера.
// Не требует доп. зависимостей: используем тот же @seald-io/nedb что и везде.
const Store = session.Store;

class NeDBSessionStore extends Store {
  constructor(opts = {}) {
    super();
    this.db = new NeDB({ filename: opts.filename, autoload: true });
    // Чистим протухшие сессии каждые 10 минут
    setInterval(() => {
      this.db.remove({ expiresAt: { $lt: Date.now() } }, { multi: true });
    }, 10 * 60 * 1000);
  }

  get(sid, cb) {
    this.db.findOne({ _id: sid, expiresAt: { $gt: Date.now() } }, (err, doc) => {
      if (err) return cb(err);
      cb(null, doc ? doc.session : null);
    });
  }

  set(sid, sess, cb) {
    const maxAge  = (sess.cookie && sess.cookie.maxAge) ? sess.cookie.maxAge : 8 * 60 * 60 * 1000;
    const expires = Date.now() + maxAge;
    this.db.update(
      { _id: sid },
      { _id: sid, session: sess, expiresAt: expires },
      { upsert: true },
      cb || (() => {})
    );
  }

  destroy(sid, cb) {
    this.db.remove({ _id: sid }, {}, cb || (() => {}));
  }

  touch(sid, sess, cb) {
    const maxAge  = (sess.cookie && sess.cookie.maxAge) ? sess.cookie.maxAge : 8 * 60 * 60 * 1000;
    const expires = Date.now() + maxAge;
    this.db.update({ _id: sid }, { $set: { expiresAt: expires, session: sess } }, {}, cb || (() => {}));
  }
}

// ── CSRF токен ────────────────────────────────────────────────────────────────
function ensureCsrfToken(req, res, next) {
  if (!req.session) return next();
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  next();
}

// ── Сессия ────────────────────────────────────────────────────────────────────
// sameSite:'none' + secure:true обязательны чтобы кука работала
// когда сайт открыт в iframe (Foundry).
const isProduction = process.env.NODE_ENV === 'production';
app.use(session({
  secret: process.env.SECRET || 'crypto-dev-secret-2025',
  resave: false,
  saveUninitialized: false,
  store: new NeDBSessionStore({
    filename: path.join(__dirname, 'data', 'sessions.db'),
  }),
  cookie: {
    maxAge: 8 * 60 * 60 * 1000,
    sameSite: isProduction ? 'none' : 'lax',  // 'none' нужен для iframe на prod
    secure:   isProduction,                    // secure обязателен при sameSite:'none'
  }
}));

app.use(ensureCsrfToken);

// ── CSRF guard ────────────────────────────────────────────────────────────────
const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const CSRF_EXCEPT_PATHS = [
  /^\/auth\/login$/,
  /^\/auth\/logout$/,
];

function csrfGuard(req, res, next) {
  if (CSRF_SAFE_METHODS.has(req.method)) return next();

  const path = req.path || '';
  if (CSRF_EXCEPT_PATHS.some(rx => rx.test(path))) return next();

  const tokenHeader = req.headers['x-csrf-token'] || req.headers['X-CSRF-Token'];
  const sessionToken = req.session && req.session.csrfToken;

  if (!sessionToken || !tokenHeader || tokenHeader !== sessionToken) {
    return res.status(403).json({ error: 'CSRF validation failed' });
  }

  next();
}

app.use('/api', csrfGuard);
app.use('/auth', csrfGuard);

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

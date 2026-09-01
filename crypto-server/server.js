require('dotenv').config();
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

// Пишущими считаем только не-GET запросы: GET /api/orders и /api/loan/info — чтение
function isWriteRoute(req) {
  return req.method !== 'GET' && /^\/api\/(trade|loan|repay|transfer|orders)/.test(req.path);
}

function rateLimiter(req, res, next) {
  const ip    = getIp(req);
  const limit = isWriteRoute(req) ? LIMIT_WRITE : LIMIT_READ;
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
}, 30_000).unref();

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
    }, 10 * 60 * 1000).unref();
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
    console.log('   Для остановки: Ctrl+C в этом окне (дождись "данные сохранены")\n');
  });
}).catch(err => {
  console.error('Ошибка запуска:', err);
});

// ── Корректная остановка ────────────────────────────────────────────────────
// Останавливаем тик и дожидаемся, пока текущие операции NeDB допишутся на
// диск, вместо мгновенного убийства процесса (которое может оборвать запись
// файла БД посередине).
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n⏹️  ${signal} получен — останавливаю тик и завершаю текущие операции...`);
  clearInterval(marketTimer);
  io.close();
  httpServer.close(() => {
    console.log('✅ Сервер остановлен, данные сохранены на диск.');
  });
  // Подстраховка на случай, если что-то держит процесс живым дольше нормы
  setTimeout(() => {
    console.log('⌛ Таймаут остановки истёк — завершаю принудительно.');
    process.exit(0);
  }, 5000).unref();
}
process.on('SIGINT',  () => shutdown('SIGINT (Ctrl+C)'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP',  () => shutdown('SIGHUP (закрытие терминала)'));

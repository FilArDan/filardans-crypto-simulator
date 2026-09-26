require('dotenv').config();
const express = require('express');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { MongoStore } = require('connect-mongo');
const { initDb, closeDb, MONGODB_URI, MONGODB_DB_NAME } = require('./db');
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
  // Админка (одна доверенная учётная запись ГМа за сессией) не подлежит
  // IP-лимиту, придуманному против злоупотреблений игровыми эндпоинтами —
  // её дашборд легитимно шлёт пачки GET-запросов при каждом обновлении.
  if (req.session && req.session.role === 'admin') return next();

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

// ── Защита от NoSQL-инъекций ───────────────────────────────────────────────
// В проекте нет SQL (хранилище — MongoDB), поэтому классической SQL-инъекции
// тут просто неоткуда взяться. Но у NoSQL то же самое семейство атак
// работает иначе: везде, где значение из тела запроса или query-параметра
// напрямую попадает в фильтр вида db.users.findOne({ username }) — то есть
// почти во всех роутах — вместо обычной строки можно прислать объект с
// оператором NeDB/MongoDB, например {"username":{"$gt":""}}, и запрос
// внезапно начнёт матчить произвольную запись, а не сравнивать точное
// значение. Рекурсивно вырезаем любые ключи, начинающиеся на "$" (операторы)
// или содержащие "." (пути), из тела запроса и query-параметров — для
// обычных строк/чисел/массивов это не меняет ровным счётом ничего.
function stripInjectionOperators(value) {
  if (Array.isArray(value)) {
    value.forEach(stripInjectionOperators);
    return value;
  }
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      if (key.startsWith('$') || key.includes('.')) {
        delete value[key];
        continue;
      }
      stripInjectionOperators(value[key]);
    }
  }
  return value;
}
app.use((req, res, next) => {
  if (req.body)  stripInjectionOperators(req.body);
  if (req.query) stripInjectionOperators(req.query);
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ── Сессия ────────────────────────────────────────────────────────────────────
// Хранилище сессий — та же MongoDB, отдельная коллекция 'sessions'. Сессии
// эфемерны (maxAge 8ч), поэтому при переходе с NeDB на Mongo старые сессии
// намеренно не переносятся — игрокам достаточно один раз перелогиниться.
// sameSite:'none' + secure:true обязательны чтобы кука работала
// когда сайт открыт в iframe (Foundry).
const isProduction = process.env.NODE_ENV === 'production';
app.use(session({
  secret: process.env.SECRET || 'crypto-dev-secret-2025',
  resave: false,
  saveUninitialized: false,
  store: MongoStore.create({
    mongoUrl: MONGODB_URI,
    dbName: MONGODB_DB_NAME,
    collectionName: 'sessions',
    ttl: 8 * 60 * 60, // секунды, синхронизировано с cookie.maxAge ниже
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
app.use('/api',  require('./routes/profile'));

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
// Останавливаем тик и закрываем соединение с MongoDB после того, как http-
// сервер перестал принимать новые запросы, а не мгновенно убиваем процесс.
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n⏹️  ${signal} получен — останавливаю тик и завершаю текущие операции...`);
  clearInterval(marketTimer);
  io.close();
  httpServer.close(async () => {
    await closeDb().catch(() => {});
    console.log('✅ Сервер остановлен, соединение с MongoDB закрыто.');
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

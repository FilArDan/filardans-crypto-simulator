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

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SECRET || 'crypto-dev-secret-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

app.use('/auth', require('./routes/auth'));
app.use('/api',  require('./routes/game'));

const marketTick = () => tick(io);
app.set('marketTick', marketTick);

// Динамическая скорость тика (по умолчанию 25 сек)
let tickSpeedMs = 25000;
let marketTimer = setInterval(marketTick, tickSpeedMs);

app.set('setTickSpeed', (ms) => {
  clearInterval(marketTimer);
  tickSpeedMs = ms;
  marketTimer = setInterval(marketTick, tickSpeedMs);
  // Эмитируем tickSpeedChanged только здесь — роут /admin/set-tick-speed не дублирует
  io.emit('tickSpeedChanged', { ms: tickSpeedMs });
});
app.set('getTickSpeed', () => tickSpeedMs);

io.on('connection', socket => {
  console.log('[socket] подключился:', socket.id);
  // Сообщаем новому клиенту текущую скорость
  socket.emit('tickSpeedChanged', { ms: tickSpeedMs });
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

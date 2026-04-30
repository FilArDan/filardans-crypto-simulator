// ===== СОКЕТ: общение ГМ ↔ Игроки =====
// Все сообщения идут через game.socket.emit('module.crypto-simulator', msg)

export const MSG = {
  TICK_UPDATE:   'tick_update',    // ГМ → все: новые цены + состояния
  TRADE_REQUEST: 'trade_request',  // Игрок → ГМ: хочу купить/продать
  TRADE_RESULT:  'trade_result',   // ГМ → игрок: результат сделки
  FORCE_REFRESH: 'force_refresh',  // ГМ → все: перерисовать UI
};

const SOCKET_NAME = 'module.crypto-simulator';

export function emitToGM(type, payload) {
  game.socket.emit(SOCKET_NAME, { type, payload, senderId: game.user.id });
}

export function emitToAll(type, payload) {
  game.socket.emit(SOCKET_NAME, { type, payload, senderId: game.user.id });
}

export function emitToUser(userId, type, payload) {
  // В Foundry нельзя слать напрямую одному, поэтому шлём всем, фильтруем у получателя
  game.socket.emit(SOCKET_NAME, { type, payload, targetId: userId, senderId: game.user.id });
}

export function setupSocket(handlers) {
  game.socket.on(SOCKET_NAME, (msg) => {
    // Пропускаем если сообщение не для нас
    if(msg.targetId && msg.targetId !== game.user.id) return;
    const handler = handlers[msg.type];
    if(handler) handler(msg.payload, msg.senderId);
  });
}

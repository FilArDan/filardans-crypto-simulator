// ===== СОКЕТ =====
export const MSG = {
  TICK_UPDATE:   'tick_update',
  TRADE_REQUEST: 'trade_request',
  TRADE_RESULT:  'trade_result',
  FORCE_REFRESH: 'force_refresh',
};

const SOCK = 'module.fad-crypto-simulator';

export const emitToGM  = (type, payload) =>
  game.socket.emit(SOCK, { type, payload, senderId: game.user.id });

export const emitToAll = (type, payload) =>
  game.socket.emit(SOCK, { type, payload, senderId: game.user.id });

// targetId — на ВЕРХНЕМ уровне сообщения
export const emitToUser = (userId, type, payload) =>
  game.socket.emit(SOCK, { type, payload, targetId: userId, senderId: game.user.id });

export function setupSocket(handlers) {
  game.socket.on(SOCK, msg => {
    if (msg.targetId && msg.targetId !== game.user.id) return;
    handlers[msg.type]?.(msg.payload, msg.senderId);
  });
}
/* ===== МОНЕТЫ: данные, цвета, supply ===== */
const COINS = {
  BTC: { name:'Bitcoin',            price:65000,  basePrice:65000, vol:.030,  col:'#F7931A',  supply:21000000     },
  ETH: { name:'Ethereum',           price:3200,   basePrice:3200,  vol:.045,  col:'#627EEA',  supply:120000000    },
  SOL: { name:'Solana',             price:145,    basePrice:145,   vol:.070,  col:'#9945FF',  supply:440000000    },
  BNB: { name:'BNB',                price:580,    basePrice:580,   vol:.040,  col:'#F3BA2F',  supply:145000000    },
  KRH: { name:'КрахмалКоин',        price:1250,   basePrice:1250,  vol:.045,  col:'#086925',  supply:440000000    },
  BYN: { name:'Беларусский Рубль',  price:0.36,   basePrice:0.36,  vol:.045,  col:'#086925',  supply:18500000000  },
};
const SYMS = Object.keys(COINS);
const FEE  = 0.01;   // 1% комиссия
const START = 10000; // стартовый баланс игрока
# FCS — Foundry Crypto Simulator

Модуль для Foundry VTT v13, открывающий [Filardans Crypto Simulator](https://filardans-crypto-simulator-production.up.railway.app) прямо внутри Foundry в виде отдельного окна.

Сайт живёт отдельно на Railway. Модуль — лёгкая обёртка без глубокой интеграции.

---

## Установка

### Способ 1 — вручную

1. Скачай папку `fcs-foundry` целиком.
2. Помести её в `Data/modules/fcs-foundry/`.
3. Перезапусти Foundry → **Add-on Modules** → включи **FCS — Crypto Simulator**.

### Способ 2 — по Manifest URL *(если опубликован)*

Вставь URL `module.json` в поле **Manifest URL** при установке модуля.

---

## Использование

| Действие | Результат |
|---|---|
| **Alt + C** | Открыть/развернуть окно симулятора |
| Кнопка 📈 в Scene Controls | То же самое |
| Перетащить/растянуть окно | Стандартное поведение Foundry |

---

## Как это работает

```
Foundry VTT
  └── ApplicationV2 (окно)
        └── <iframe src="https://...railway.app?embedded=foundry">
              └── Сайт симулятора (Railway)
```

Сайт получает query-параметры:
- `embedded=foundry` — сайт может адаптировать UI
- `user=ИмяИгрока` — имя из Foundry
- `role=НомерРоли` — роль пользователя в мире

Также по событию `load` модуль отправляет `postMessage` с объектом:
```json
{ "type": "fcs:init", "userName": "...", "userRole": 1, "world": "..." }
```

---

## Требования

- Foundry VTT **v13+**
- Сервер симулятора должен быть доступен в сети (Railway деплой)

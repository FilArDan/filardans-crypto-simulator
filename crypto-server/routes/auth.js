const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();
const { db } = require('../db');

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password)
      return res.status(400).json({ error: 'Укажите логин и пароль' });
    const user = await db.users.findOne({ username });
    if (!user || !bcrypt.compareSync(password, user.passwordHash))
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    req.session.username = user.username;
    req.session.role = user.role;
    // Ждём записи сессии в store перед ответом — иначе /auth/me может
    // получить пустую сессию если store (NeDB) ещё не успел сохранить.
    req.session.save(err => {
      if (err) return res.status(500).json({ error: 'Ошибка сессии' });
      res.json({
        username: user.username,
        role: user.role,
        csrfToken: req.session.csrfToken,
      });
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

router.get('/me', (req, res) => {
  if (!req.session.username)
    return res.status(401).json({ error: 'Не авторизован' });
  res.json({
    username: req.session.username,
    role: req.session.role,
    csrfToken: req.session.csrfToken,
  });
});

module.exports = router;

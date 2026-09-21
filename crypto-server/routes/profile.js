/* ===== ПРОФИЛЬ ИГРОКА =====
 * Отображаемое имя и аватарка — чисто витринные поля поверх username
 * (который остаётся неизменным ключом во всех остальных коллекциях), плюс
 * личная настройка режима интерфейса (полный/упрощённый).
 */
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();
const { db }  = require('../db');

function auth(req, res, next) {
  if (!req.session.username) return res.status(401).json({ error: 'Не авторизован' });
  next();
}

const AVATAR_DIR = path.join(__dirname, '..', 'public', 'avatars');
fs.mkdirSync(AVATAR_DIR, { recursive: true });

const ALLOWED_MIME = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

const upload = multer({
  storage: multer.diskStorage({
    destination: AVATAR_DIR,
    filename: (req, file, cb) => {
      const ext = ALLOWED_MIME[file.mimetype] || '.png';
      cb(null, `${req.session.username}-${Date.now()}${ext}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME[file.mimetype]) return cb(new Error('Разрешены только PNG/JPEG/WEBP/GIF'));
    cb(null, true);
  },
});

async function profileFor(user) {
  return {
    username: user.username,
    displayName: user.displayName || user.username,
    avatarUrl: user.avatarPath ? `/avatars/${user.avatarPath}` : null,
    uiMode: user.uiMode === 'simple' ? 'simple' : 'full',
  };
}

router.get('/profile', auth, async (req, res) => {
  try {
    const user = await db.users.findOne({ username: req.session.username });
    if (!user) return res.status(404).json({ error: 'Не найдено' });
    res.json(await profileFor(user));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/profile', auth, async (req, res) => {
  try {
    const patch = {};
    if (req.body.displayName !== undefined) {
      const name = String(req.body.displayName).trim().slice(0, 32);
      patch.displayName = name || req.session.username;
    }
    if (req.body.uiMode !== undefined) {
      patch.uiMode = req.body.uiMode === 'simple' ? 'simple' : 'full';
    }
    if (Object.keys(patch).length) {
      await db.users.update({ username: req.session.username }, { $set: patch });
    }
    const user = await db.users.findOne({ username: req.session.username });
    res.json({ ok: true, ...(await profileFor(user)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

router.post('/profile/avatar', auth, (req, res) => {
  upload.single('avatar')(req, res, async (err) => {
    try {
      if (err) return res.status(400).json({ error: err.message });
      if (!req.file) return res.status(400).json({ error: 'Файл не получен' });

      const user = await db.users.findOne({ username: req.session.username });
      if (user && user.avatarPath) {
        fs.unlink(path.join(AVATAR_DIR, user.avatarPath), () => {});
      }
      await db.users.update({ username: req.session.username }, { $set: { avatarPath: req.file.filename } });
      res.json({ ok: true, avatarUrl: `/avatars/${req.file.filename}` });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });
});

module.exports = router;

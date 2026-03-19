const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const rateLimit = require('express-rate-limit');

function sanitize(str, maxLen=100){
  if(typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen).replace(/[<>]/g, '');
}

const PORT       = process.env.PORT || 3000;
const dataDir    = path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
const dbFile     = path.join(dataDir, 'db.json');

[dataDir, uploadsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function loadDB() {
  try { return JSON.parse(fs.readFileSync(dbFile, 'utf8')); }
  catch { return { messages: {}, rooms: ['Allgemein', 'Gaming', 'Musik'], roomPasswords: {}, profiles: {}, dms: {}, voiceChannels: ['Lounge', 'Gaming VC', 'Musik VC'], voicePasswords: {} }; }
}
function saveDB(db) {
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
}

let db = loadDB();
if (!db.dms)            { db.dms = {};            saveDB(db); }
if (!db.voiceChannels)  { db.voiceChannels = ['Lounge', 'Gaming VC', 'Musik VC']; saveDB(db); }
if (!db.roomPasswords)  { db.roomPasswords = {};  saveDB(db); }
if (!db.voicePasswords) { db.voicePasswords = {}; saveDB(db); }

function addMessage(room, msg) {
  if (!db.messages[room]) db.messages[room] = [];
  db.messages[room].push(msg);
  if (db.messages[room].length > 200) db.messages[room] = db.messages[room].slice(-200);
  saveDB(db);
}
function getMessages(room) {
  return (db.messages[room] || []).slice(-80);
}
function dmKey(nameA, nameB) { return [nameA, nameB].sort().join('__DM__'); }
function addDM(nameA, nameB, msg) {
  const key = dmKey(nameA, nameB);
  if (!db.dms[key]) db.dms[key] = [];
  db.dms[key].push(msg);
  if (db.dms[key].length > 200) db.dms[key] = db.dms[key].slice(-200);
  saveDB(db);
}
function getDMs(nameA, nameB) { return (db.dms[dmKey(nameA, nameB)] || []).slice(-100); }

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

const app    = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 25e6,
  pingTimeout: 60000,
  pingInterval: 25000
});

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: 'Zu viele Anfragen, bitte warte kurz.' });
const uploadLimiter = rateLimit({ windowMs: 60 * 1000, max: 10 });
app.use(limiter);
app.use('/uploads', express.static(uploadsDir));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(express.json());
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.post('/upload', uploadLimiter, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  const host = process.env.APP_URL || `http://localhost:${PORT}`;
  res.json({ url: `${host}/uploads/${req.file.filename}`, name: req.file.originalname });
});
app.get('/history/:room', (req, res) => res.json(getMessages(req.params.room)));
app.get('/rooms', (req, res) => res.json(db.rooms));
app.get('/dm-history', (req, res) => {
  const { a, b } = req.query;
  if (!a || !b) return res.status(400).json({ error: 'Missing names' });
  res.json(getDMs(a, b));
});

const users = {}, voiceRooms = {};
function ts() { return new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }); }
function broadcastUsers() { io.emit('userList', Object.entries(users).map(([id, u]) => ({ id, ...u }))); }
function broadcastRooms() { io.emit('roomList', db.rooms); }
function sysMsg(room, text) { io.to(room).emit('message', { id: Date.now(), user: 'System', type: 'system', content: text, timestamp: ts() }); }

io.on('connection', socket => {
  const pingInterval = setInterval(() => socket.emit('ping_check', Date.now()), 10000);
  socket.on('pong_check', t => socket.emit('ping_result', Date.now() - t));

  socket.on('join', ({ name, room = 'Allgemein', color = '#5865f2', avatar = '😎' }) => {
    name = sanitize(name, 24);
    room = sanitize(room, 32);
    if (!name) return;
    users[socket.id] = { name, room, color, avatar, status: 'online', inVoice: false };
    if (!db.rooms.includes(room)) { db.rooms.push(room); saveDB(db); }
    socket.join(room);
    socket.emit('joined', { name, room });
    socket.emit('roomList', db.rooms);
    socket.emit('history', getMessages(room));
    socket.emit('voiceChannelList', db.voiceChannels);
    broadcastUsers();
    sysMsg(room, `${name} ist beigetreten.`);
  });

  socket.on('updateProfile', ({ name, color, avatar }) => {
    const u = users[socket.id]; if (!u) return;
    if (name)   u.name   = name;
    if (color)  u.color  = color;
    if (avatar) u.avatar = typeof avatar === 'string' ? avatar.slice(0, 500000) : avatar;
    broadcastUsers();
    socket.emit('profileUpdated', { name: u.name, color: u.color, avatar: u.avatar });
  });
  socket.on('setStatus', status => {
    if (users[socket.id]) { users[socket.id].status = status; broadcastUsers(); }
  });

  // ── ROOM PASSWORD CHECK ──
  socket.on('checkRoomPassword', ({ room }) => {
    room = sanitize(room, 32);
    if (db.roomPasswords[room]) {
      socket.emit('roomNeedsPassword', { room });
    } else {
      socket.emit('roomNoPassword', { room });
    }
  });

  // ── CHANGE ROOM (with optional password) ──
  socket.on('changeRoom', ({ newRoom, password }) => {
    const u = users[socket.id]; if (!u) return;
    newRoom = sanitize(newRoom, 32);
    // Passwort prüfen falls gesetzt
    if (db.roomPasswords[newRoom]) {
      if (!password || db.roomPasswords[newRoom] !== password) {
        socket.emit('roomPasswordWrong');
        return;
      }
    }
    sysMsg(u.room, `${u.name} hat den Raum verlassen.`);
    socket.leave(u.room);
    u.room = newRoom;
    if (!db.rooms.includes(newRoom)) { db.rooms.push(newRoom); saveDB(db); }
    socket.join(newRoom);
    socket.emit('roomChanged', { room: newRoom, history: getMessages(newRoom) });
    broadcastUsers();
    sysMsg(newRoom, `${u.name} ist beigetreten.`);
  });

  socket.on('createRoom', ({ name, password }) => {
    name = sanitize(name, 32);
    if (!name || db.rooms.includes(name)) return;
    db.rooms.push(name);
    if (password) db.roomPasswords[name] = sanitize(password, 32);
    saveDB(db);
    broadcastRooms();
  });

  socket.on('deleteRoom', ({ name }) => {
    if (!name || name === 'Allgemein') return;
    db.rooms = db.rooms.filter(r => r !== name);
    delete db.messages[name];
    delete db.roomPasswords[name];
    saveDB(db);
    broadcastRooms();
    io.emit('roomDeleted', { name });
  });

  // ── VOICE CHANNEL PASSWORD CHECK ──
  socket.on('checkVoicePassword', ({ room }) => {
    room = sanitize(room, 32);
    if (db.voicePasswords[room]) {
      socket.emit('voiceNeedsPassword', { room });
    } else {
      socket.emit('voiceNoPassword', { room });
    }
  });

  // ── JOIN VOICE WITH PASSWORD ──
  socket.on('joinVoiceWithPassword', ({ room, password }) => {
    room = sanitize(room, 32);
    password = sanitize(password, 32);
    if (db.voicePasswords[room] && db.voicePasswords[room] !== password) {
      socket.emit('voicePasswordWrong');
      return;
    }
    socket.emit('voicePasswordOk', { room });
  });

  socket.on('createVoiceChannel', ({ name, password }) => {
    name = sanitize(name, 32);
    if (!name || db.voiceChannels.includes(name)) return;
    db.voiceChannels.push(name);
    if (password) db.voicePasswords[name] = sanitize(password, 32);
    saveDB(db);
    io.emit('voiceChannelList', db.voiceChannels);
  });

  socket.on('deleteVoiceChannel', ({ name }) => {
    if (!name || ['Lounge', 'Gaming VC', 'Musik VC'].includes(name)) return;
    db.voiceChannels = db.voiceChannels.filter(v => v !== name);
    delete db.voicePasswords[name];
    saveDB(db);
    io.emit('voiceChannelList', db.voiceChannels);
  });

  socket.on('joinVoice', ({ room }) => {
    Object.entries(voiceRooms).forEach(([r, members]) => {
      if (r !== room && members.has(socket.id)) {
        members.delete(socket.id);
        io.emit('voicePeerLeft', { peerId: socket.id });
      }
    });
    if (!voiceRooms[room]) voiceRooms[room] = new Set();
    if (voiceRooms[room].has(socket.id)) return;
    const peers = [...voiceRooms[room]];
    voiceRooms[room].add(socket.id);
    if (users[socket.id]) users[socket.id].inVoice = true;
    socket.emit('voicePeers', { peers, room });
    peers.forEach(pid => io.to(pid).emit('voicePeerJoined', { peerId: socket.id, name: users[socket.id]?.name }));
    broadcastUsers();
  });

  socket.on('leaveVoice', ({ room }) => {
    voiceRooms[room]?.delete(socket.id);
    if (users[socket.id]) users[socket.id].inVoice = false;
    io.emit('voicePeerLeft', { peerId: socket.id });
    broadcastUsers();
  });

  
  socket.on('message', ({ text, room, type = 'text', fileUrl, fileName, fmtStyle }) => {
  
    text = sanitize(text, 2000);
room = sanitize(room, 32);
fmtStyle = typeof fmtStyle === 'string' ? fmtStyle.slice(0, 500) : null;
    const u = users[socket.id]; if (!u) return;
    const allowedTypes = ['text', 'image', 'file', 'formatted'];
if (!allowedTypes.includes(type)) return;
    const msg = {
  id: Date.now(), user: u.name, userId: socket.id,
  color: u.color, avatar: u.avatar,
  type, content: type === 'file' || type === 'image' ? fileUrl : text,
  fileName: fileName || null, fmtStyle: fmtStyle||null, timestamp: ts()
};
    addMessage(room, msg);
    io.to(room).emit('message', msg);
  });

  socket.on('deleteMessage', ({ room, msgId }) => {
    const u = users[socket.id]; if (!u) return;
    if (db.messages[room]) {
      const msg = db.messages[room].find(m => m.id === msgId);
      if (msg && (msg.userId === socket.id || msg.user === u.name)) {
        db.messages[room] = db.messages[room].filter(m => m.id !== msgId);
        saveDB(db);
        io.to(room).emit('messageDeleted', { msgId });
      }
    }
  });

  socket.on('clearChat', ({ room }) => {
    db.messages[room] = [];
    saveDB(db);
    io.to(room).emit('chatCleared', { room });
  });

  socket.on('rtc-offer',  ({ targetId, offer })     => io.to(targetId).emit('rtc-offer',  { fromId: socket.id, fromName: users[socket.id]?.name, offer }));
  socket.on('rtc-answer', ({ targetId, answer })    => io.to(targetId).emit('rtc-answer', { fromId: socket.id, answer }));
  socket.on('rtc-ice',    ({ targetId, candidate }) => io.to(targetId).emit('rtc-ice',    { fromId: socket.id, candidate }));
  socket.on('rtc-hangup', ({ targetId }) => {
    io.to(targetId).emit('rtc-hangup', { fromId: socket.id });
    if (users[socket.id]) { users[socket.id].inVoice = false; broadcastUsers(); }
  });

  socket.on('playSound', ({ room, soundName, soundData }) => {
    socket.to(room).emit('playSound', { soundName, soundData, fromName: users[socket.id]?.name });
  });
  socket.on('stopSound', ({ room }) => socket.to(room).emit('stopSound'));

  socket.on('typing', ({ room }) => {
    const u = users[socket.id];
    if (u) socket.to(room).emit('typing', { name: u.name });
  });

  socket.on('privateMessage', ({ targetId, text }) => {
    const sender = users[socket.id], receiver = users[targetId];
    if (!sender) return;
    const msg = { fromId: socket.id, fromName: sender.name, targetId, text, timestamp: ts() };
    if (receiver) addDM(sender.name, receiver.name, msg);
    io.to(targetId).emit('privateMessage', { ...msg, toSelf: false });
    socket.emit('privateMessage', { ...msg, toSelf: true });
  });

  socket.on('getDmHistory', ({ targetName }) => {
    const me = users[socket.id]; if (!me || !targetName) return;
    socket.emit('dmHistory', { targetName, messages: getDMs(me.name, targetName) });
  });

  socket.on('privateCall', ({ targetId }) => {
    const caller = users[socket.id]; if (!caller) return;
    io.to(targetId).emit('privateCallIncoming', { fromId: socket.id, fromName: caller.name });
  });
  socket.on('privateCallAccept', ({ targetId }) => {
  const privateRoom = `private_${[socket.id, targetId].sort().join('_')}`;
  io.to(targetId).emit('privateCallAccepted', { fromId: socket.id, privateRoom });
  io.to(socket.id).emit('privateCallAccepted', { fromId: targetId, privateRoom });
});

  socket.on('disconnect', () => {
    clearInterval(pingInterval);
    const u = users[socket.id];
    if (u) {
      sysMsg(u.room, `${u.name} hat die App verlassen.`);
      Object.values(voiceRooms).forEach(s => s.delete(socket.id));
      io.emit('voicePeerLeft', { peerId: socket.id });
      delete users[socket.id];
      broadcastUsers();
    }
  });
});



server.listen(PORT, () => console.log(`✅ Server läuft auf Port ${PORT}`));
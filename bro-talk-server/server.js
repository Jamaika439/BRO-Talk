const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');

// ── Ordner & JSON-DB Setup ───────────────
const dataDir    = path.join(__dirname, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
const dbFile     = path.join(dataDir, 'db.json');

[dataDir, uploadsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

function loadDB() {
  try { return JSON.parse(fs.readFileSync(dbFile, 'utf8')); }
  catch { return { messages: {}, rooms: ['Allgemein', 'Gaming', 'Musik'], profiles: {}, dms: {} }; }
}
function saveDB(db) {
  fs.writeFileSync(dbFile, JSON.stringify(db, null, 2));
}

let db = loadDB();
// Migration: dms-Feld sicherstellen
if (!db.dms) { db.dms = {}; saveDB(db); }

function addMessage(room, msg) {
  if (!db.messages[room]) db.messages[room] = [];
  db.messages[room].push(msg);
  if (db.messages[room].length > 200) db.messages[room] = db.messages[room].slice(-200);
  saveDB(db);
}
function getMessages(room) {
  return (db.messages[room] || []).slice(-80);
}

// ── DM Persistenz ───────────────────────
// Key = sortiertes Paar "id1_id2" – aber wir indexieren nach beiden socketIds
// Da socket IDs bei Reconnect wechseln, speichern wir nach Name-Paaren
function dmKey(nameA, nameB) {
  return [nameA, nameB].sort().join('__DM__');
}
function addDM(nameA, nameB, msg) {
  const key = dmKey(nameA, nameB);
  if (!db.dms[key]) db.dms[key] = [];
  db.dms[key].push(msg);
  // Max 200 DMs pro Konversation
  if (db.dms[key].length > 200) db.dms[key] = db.dms[key].slice(-200);
  saveDB(db);
}
function getDMs(nameA, nameB) {
  return (db.dms[dmKey(nameA, nameB)] || []).slice(-100);
}

// ── Multer ──────────────────────────────
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, '_'))
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// ── Express ─────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' }, maxHttpBufferSize: 25e6 });

app.use('/uploads', express.static(uploadsDir));
app.use(express.json());

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: `http://localhost:3000/uploads/${req.file.filename}`, name: req.file.originalname });
});

app.get('/history/:room', (req, res) => res.json(getMessages(req.params.room)));
app.get('/rooms', (req, res) => res.json(db.rooms));

// ── DM History Endpoint ─────────────────
// Client fragt: GET /dm-history?a=Alice&b=Bob
app.get('/dm-history', (req, res) => {
  const { a, b } = req.query;
  if (!a || !b) return res.status(400).json({ error: 'Missing names' });
  res.json(getDMs(a, b));
});

// ── Socket.io ───────────────────────────
const users      = {};  // socketId → { name, room, color, avatar, status, inVoice }
const voiceRooms = {};  // roomName → Set<socketId>

function ts() {
  return new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
}
function broadcastUsers() {
  io.emit('userList', Object.entries(users).map(([id, u]) => ({ id, ...u })));
}
function broadcastRooms() {
  io.emit('roomList', db.rooms);
}
function sysMsg(room, text) {
  io.to(room).emit('message', { id: Date.now(), user: 'System', type: 'system', content: text, timestamp: ts() });
}

io.on('connection', socket => {
  const pingInterval = setInterval(() => socket.emit('ping_check', Date.now()), 4000);
  socket.on('pong_check', t => socket.emit('ping_result', Date.now() - t));

  // ── JOIN ────────────────────────────
  socket.on('join', ({ name, room = 'Allgemein', color = '#5865f2', avatar = '😎' }) => {
    users[socket.id] = { name, room, color, avatar, status: 'online', inVoice: false };
    if (!db.rooms.includes(room)) { db.rooms.push(room); saveDB(db); }
    socket.join(room);
    socket.emit('joined', { name, room });
    socket.emit('roomList', db.rooms);
    socket.emit('voiceChannelList', db.voiceChannels || ['Lounge','Gaming VC','Musik VC']);
    socket.emit('history', getMessages(room));
    broadcastUsers();
    sysMsg(room, `${name} ist beigetreten.`);
  });

  // ── PROFIL ──────────────────────────
  socket.on('updateProfile', ({ name, color, avatar }) => {
    const u = users[socket.id];
    if (!u) return;
    if (name)   u.name   = name;
    if (color)  u.color  = color;
    if (avatar) u.avatar = avatar;
    broadcastUsers();
    socket.emit('profileUpdated', { name: u.name, color: u.color, avatar: u.avatar });
  });

  socket.on('setStatus', status => {
    if (users[socket.id]) { users[socket.id].status = status; broadcastUsers(); }
  });

  // ── MESSAGE ─────────────────────────
  socket.on('message', ({ text, room, type = 'text', fileUrl, fileName }) => {
    const u = users[socket.id];
    if (!u) return;
    const msg = {
      id: Date.now(), user: u.name, userId: socket.id,
      color: u.color, avatar: u.avatar,
      type, content: type === 'file' || type === 'image' ? fileUrl : text,
      fileName: fileName || null, timestamp: ts()
    };
    addMessage(room, msg);
    io.to(room).emit('message', msg);
  });

  // ── ROOMS ───────────────────────────
  socket.on('changeRoom', ({ newRoom }) => {
    const u = users[socket.id];
    if (!u) return;
    sysMsg(u.room, `${u.name} hat den Raum verlassen.`);
    socket.leave(u.room);
    u.room = newRoom;
    if (!db.rooms.includes(newRoom)) { db.rooms.push(newRoom); saveDB(db); }
    socket.join(newRoom);
    socket.emit('roomChanged', { room: newRoom, history: getMessages(newRoom) });
    broadcastUsers();
    sysMsg(newRoom, `${u.name} ist beigetreten.`);
  });

  socket.on('createRoom', ({ name }) => {
    if (!name || db.rooms.includes(name)) return;
    db.rooms.push(name);
    saveDB(db);
    broadcastRooms();
  });

  socket.on('deleteRoom', ({ name }) => {
  if(!name || name === 'Allgemein') return;
  db.rooms = db.rooms.filter(r => r !== name);
  delete db.messages[name];
  saveDB(db);
  broadcastRooms();
  io.emit('roomDeleted', { name });
});

socket.on('createVoiceChannel', ({ name }) => {
  if(!name || db.voiceChannels?.includes(name)) return;
  if(!db.voiceChannels) db.voiceChannels = ['Lounge','Gaming VC','Musik VC'];
  db.voiceChannels.push(name);
  saveDB(db);
  io.emit('voiceChannelList', db.voiceChannels);
});
  // ── VOICE ───────────────────────────
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
    peers.forEach(pid => io.to(pid).emit('voicePeerJoined', {
      peerId: socket.id, name: users[socket.id]?.name
    }));
    broadcastUsers();
  });

  socket.on('leaveVoice', ({ room }) => {
    voiceRooms[room]?.delete(socket.id);
    if (users[socket.id]) users[socket.id].inVoice = false;
    io.emit('voicePeerLeft', { peerId: socket.id });
    broadcastUsers();
  });

  // ── WebRTC SIGNALING ────────────────
  socket.on('rtc-offer',  ({ targetId, offer })     => io.to(targetId).emit('rtc-offer',  { fromId: socket.id, fromName: users[socket.id]?.name, offer }));
  socket.on('rtc-answer', ({ targetId, answer })    => io.to(targetId).emit('rtc-answer', { fromId: socket.id, answer }));
  socket.on('rtc-ice',    ({ targetId, candidate }) => io.to(targetId).emit('rtc-ice',    { fromId: socket.id, candidate }));
  socket.on('rtc-hangup', ({ targetId }) => {
    io.to(targetId).emit('rtc-hangup', { fromId: socket.id });
    if (users[socket.id]) { users[socket.id].inVoice = false; broadcastUsers(); }
  });

  // ── SOUNDBOARD ──────────────────────
  socket.on('playSound', ({ room, soundName, soundData }) => {
    socket.to(room).emit('playSound', { soundName, soundData, fromName: users[socket.id]?.name });
  });

  // ── TYPING ──────────────────────────
  socket.on('typing', ({ room }) => {
    const u = users[socket.id];
    if (u) socket.to(room).emit('typing', { name: u.name });
  });

  // ── PRIVATE MESSAGES (mit Persistenz) ─
  socket.on('privateMessage', ({ targetId, text }) => {
    const sender   = users[socket.id];
    const receiver = users[targetId];
    if (!sender) return;
    const msg = {
      fromId:   socket.id,
      fromName: sender.name,
      targetId,
      text,
      timestamp: ts()
    };
    // In DB speichern (nach Namen, da IDs sich ändern)
    if (receiver) addDM(sender.name, receiver.name, msg);

    // An Empfänger senden
    io.to(targetId).emit('privateMessage', { ...msg, toSelf: false });
    // Zurück an Sender (Bestätigung)
    socket.emit('privateMessage', { ...msg, toSelf: true });
  });

  // ── DM History laden ────────────────
  // Client fragt gezielt nach History wenn er DM öffnet
  socket.on('getDmHistory', ({ targetName }) => {
    const me = users[socket.id];
    if (!me || !targetName) return;
    const history = getDMs(me.name, targetName);
    socket.emit('dmHistory', { targetName, messages: history });
  });

  // ── PRIVATE CALL ────────────────────
  socket.on('privateCall', ({ targetId }) => {
    const caller = users[socket.id];
    if (!caller) return;
    io.to(targetId).emit('privateCallIncoming', { fromId: socket.id, fromName: caller.name });
  });
  socket.on('privateCallAccept', ({ targetId }) => {
    io.to(targetId).emit('privateCallAccepted', { fromId: socket.id });
  });
  socket.on('privateCallReject', ({ targetId }) => {
    io.to(targetId).emit('privateCallRejected', { fromId: socket.id });
  });

  // ── DISCONNECT ──────────────────────
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

server.listen(3000, () => console.log('✅ Server läuft auf Port 3000'));
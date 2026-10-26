const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  maxHttpBufferSize: 1e8, // 100 MB para envio de ficheiros
  pingInterval: 5000,
  pingTimeout: 10000,
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Rota de Healthcheck para manter o servidor Cloud gratuito ativo
app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, status: 'online', timestamp: Date.now() });
});

// Persistência em disco para que salas e mensagens continuem acessíveis
const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'aether-state.json');
const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

const rooms = new Map();

function ensureDefaultRooms() {
  const defaults = [
    { id: 'lobby-principal', name: 'Lobby Principal', isPrivate: false, password: null },
    { id: 'arena-competitiva', name: 'Arena Competitiva (2K 60FPS)', isPrivate: false, password: null },
    { id: 'cinema-squad', name: 'Cinema & Watch Party', isPrivate: false, password: null }
  ];
  defaults.forEach((d) => {
    if (!rooms.has(d.id)) {
      rooms.set(d.id, {
        id: d.id,
        name: d.name,
        isPrivate: d.isPrivate,
        password: d.password,
        users: new Map(),
        messages: []
      });
    }
  });
}

function loadPersistentState() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.rooms)) {
        parsed.rooms.forEach((r) => {
          rooms.set(r.id, {
            id: r.id,
            name: r.name,
            isPrivate: Boolean(r.isPrivate),
            password: r.password || null,
            users: new Map(),
            messages: Array.isArray(r.messages) ? r.messages.slice(-100) : []
          });
        });
      }
    }
  } catch (err) {
    console.warn('Aviso ao carregar estado persistente:', err.message);
  }
  ensureDefaultRooms();
}

let saveTimeout = null;
function scheduleSavePersistentState() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      const serializableRooms = [];
      for (const [, room] of rooms.entries()) {
        serializableRooms.push({
          id: room.id,
          name: room.name,
          isPrivate: room.isPrivate,
          password: room.password,
          // Preserva as últimas 80 mensagens da sala
          messages: room.messages.slice(-80)
        });
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify({ rooms: serializableRooms }, null, 2), 'utf-8');
    } catch (err) {
      console.warn('Aviso ao guardar estado:', err.message);
    }
  }, 600);
}

loadPersistentState();

function serializeRoomList() {
  const list = [];
  for (const [, room] of rooms.entries()) {
    list.push({
      id: room.id,
      name: room.name,
      isPrivate: room.isPrivate,
      userCount: room.users.size,
      users: Array.from(room.users.values()).map(u => ({
        socketId: u.socketId,
        name: u.name,
        nick: u.nick,
        avatarColor: u.avatarColor,
        isMuted: u.isMuted,
        isDeafened: u.isDeafened,
        isStreaming: u.isStreaming,
        voiceStreamId: u.voiceStreamId || null,
        screenStreamId: u.screenStreamId || null,
        streamConfig: u.streamConfig
      }))
    });
  }
  return list;
}

io.on('connection', (socket) => {
  let currentUser = null;
  let currentRoomId = null;

  socket.on('user:register', ({ name, nick, avatarColor }, callback) => {
    currentUser = {
      socketId: socket.id,
      name: String(name || 'Utilizador').trim(),
      nick: String(nick || 'user').trim().replace(/^@/, '').replace(/\s+/g, '_').toLowerCase(),
      avatarColor: avatarColor || '#5E81F4',
      isMuted: false,
      isDeafened: false,
      isStreaming: false,
      voiceStreamId: null,
      screenStreamId: null,
      streamConfig: null
    };
    callback?.({ ok: true, user: currentUser, rooms: serializeRoomList() });
  });

  socket.on('room:create', ({ name, isPrivate, password }, callback) => {
    if (!name || !name.trim()) return callback?.({ ok: false, error: 'Nome inválido.' });
    const id = 'room-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6);
    rooms.set(id, {
      id,
      name: name.trim(),
      isPrivate: Boolean(isPrivate),
      password: isPrivate ? String(password || '') : null,
      users: new Map(),
      messages: []
    });
    scheduleSavePersistentState();
    io.emit('rooms:update', serializeRoomList());
    callback?.({ ok: true, roomId: id });
  });

  socket.on('room:join', ({ roomId, password }, callback) => {
    if (!currentUser) return callback?.({ ok: false, error: 'Utilizador não autenticado.' });
    const targetRoom = rooms.get(roomId);
    if (!targetRoom) return callback?.({ ok: false, error: 'Sala não encontrada.' });

    if (targetRoom.isPrivate && targetRoom.password !== String(password || '')) {
      return callback?.({ ok: false, error: 'Palavra-passe incorreta para esta sala privada.' });
    }

    if (currentRoomId && rooms.has(currentRoomId)) {
      const oldRoom = rooms.get(currentRoomId);
      oldRoom.users.delete(socket.id);
      socket.leave(currentRoomId);
      socket.to(currentRoomId).emit('peer:left', { socketId: socket.id });
    }

    currentUser.isStreaming = false;
    currentUser.screenStreamId = null;
    currentUser.streamConfig = null;

    currentRoomId = roomId;
    targetRoom.users.set(socket.id, currentUser);
    socket.join(roomId);

    socket.to(roomId).emit('peer:joined', { user: currentUser });
    io.emit('rooms:update', serializeRoomList());

    callback?.({
      ok: true,
      room: {
        id: targetRoom.id,
        name: targetRoom.name,
        isPrivate: targetRoom.isPrivate,
        users: Array.from(targetRoom.users.values()),
        messages: targetRoom.messages.slice(-100)
      }
    });
  });

  socket.on('user:state-change', (patch) => {
    if (!currentUser || !currentRoomId) return;
    Object.assign(currentUser, patch);
    socket.to(currentRoomId).emit('peer:state-updated', {
      socketId: socket.id,
      patch
    });
    io.emit('rooms:update', serializeRoomList());
  });

  socket.on('webrtc:signal', ({ to, data }) => {
    io.to(to).emit('webrtc:signal', {
      from: socket.id,
      user: currentUser,
      data
    });
  });

  socket.on('chat:message', (payload) => {
    if (!currentUser || !currentRoomId || !rooms.has(currentRoomId)) return;
    const room = rooms.get(currentRoomId);

    const now = Date.now();
    const messageObj = {
      id: 'msg-' + now + '-' + Math.random().toString(36).substring(2, 6),
      senderId: socket.id,
      senderName: currentUser.name,
      senderNick: currentUser.nick,
      avatarColor: currentUser.avatarColor,
      text: payload.text || '',
      replyTo: payload.replyTo || null,
      file: payload.file || null,
      createdAt: now,
      edited: false,
      editedAt: null,
      timestamp: new Date(now).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    };

    room.messages.push(messageObj);
    if (room.messages.length > 150) room.messages.shift();
    scheduleSavePersistentState();

    io.to(currentRoomId).emit('chat:new-message', messageObj);
  });

  socket.on('chat:edit-message', ({ messageId, newText }, callback) => {
    if (!currentUser || !currentRoomId || !rooms.has(currentRoomId)) {
      return callback?.({ ok: false, error: 'Sessão inválida.' });
    }
    const trimmed = String(newText || '').trim();
    if (!trimmed) {
      return callback?.({ ok: false, error: 'A mensagem não pode ficar vazia.' });
    }

    const room = rooms.get(currentRoomId);
    const msg = room.messages.find(m => m.id === messageId);
    if (!msg) {
      return callback?.({ ok: false, error: 'Mensagem não encontrada.' });
    }

    const isAuthor = msg.senderId === socket.id || msg.senderNick === currentUser.nick;
    if (!isAuthor) {
      return callback?.({ ok: false, error: 'Só pode editar as suas próprias mensagens.' });
    }

    const elapsed = Date.now() - (msg.createdAt || 0);
    if (elapsed > FIFTEEN_MINUTES_MS) {
      return callback?.({ ok: false, error: 'O limite de 15 minutos para edição já expirou.' });
    }

    msg.text = trimmed;
    msg.edited = true;
    msg.editedAt = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    scheduleSavePersistentState();

    io.to(currentRoomId).emit('chat:message-edited', {
      messageId: msg.id,
      newText: msg.text,
      edited: true,
      editedAt: msg.editedAt
    });

    callback?.({ ok: true });
  });

  socket.on('chat:delete-message', ({ messageId }, callback) => {
    if (!currentUser || !currentRoomId || !rooms.has(currentRoomId)) {
      return callback?.({ ok: false, error: 'Sessão inválida.' });
    }
    const room = rooms.get(currentRoomId);
    const idx = room.messages.findIndex(m => m.id === messageId);
    if (idx === -1) {
      return callback?.({ ok: false, error: 'Mensagem não encontrada.' });
    }

    const msg = room.messages[idx];
    const isAuthor = msg.senderId === socket.id || msg.senderNick === currentUser.nick;
    if (!isAuthor) {
      return callback?.({ ok: false, error: 'Só pode excluir as suas próprias mensagens.' });
    }

    const elapsed = Date.now() - (msg.createdAt || 0);
    if (elapsed > FIFTEEN_MINUTES_MS) {
      return callback?.({ ok: false, error: 'O tempo limite de 15 minutos para exclusão já expirou.' });
    }

    room.messages.splice(idx, 1);
    scheduleSavePersistentState();
    io.to(currentRoomId).emit('chat:message-deleted', { messageId });
    callback?.({ ok: true });
  });

  socket.on('disconnect', () => {
    if (currentRoomId && rooms.has(currentRoomId)) {
      const room = rooms.get(currentRoomId);
      room.users.delete(socket.id);
      socket.to(currentRoomId).emit('peer:left', { socketId: socket.id });
      io.emit('rooms:update', serializeRoomList());
    }
  });
});

// Keep-Alive automático quando alojado gratuitamente no Render.com
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    https.get(`${process.env.RENDER_EXTERNAL_URL}/health`, () => {}).on('error', () => {});
  }, 10 * 60 * 1000);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n============================================================`);
  console.log(`🚀 AETHER REALTIME ENGINE ATIVO NA PORTA ${PORT}`);
  console.log(`👉 Local: http://localhost:${PORT}`);
  console.log(`============================================================\n`);
});
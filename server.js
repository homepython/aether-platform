'use strict';

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 75 * 1024 * 1024,
  pingTimeout: 25000,
  pingInterval: 10000
});

const PUBLIC_DIR = path.join(__dirname, 'public');
const RELEASE_VERSION = '1.0.0';
const GITHUB_RELEASE_EXE_URL =
  process.env.AETHER_DOWNLOAD_URL ||
  'https://github.com/homepython/aether-platform/releases/download/v1.0.0/Aether.Setup.exe';

// ================= ESTADO UNIFICADO (DESKTOP + WEB) =================
const users = new Map();
const rooms = new Map();

function createDefaultRooms() {
  const defaults = [
    { id: 'lobby-principal', name: 'Lobby Principal', isPrivate: false, password: '' },
    { id: 'gaming-squad', name: 'Gaming & Squad', isPrivate: false, password: '' },
    { id: 'cinema-2k', name: 'Cinema & Lives 2K', isPrivate: false, password: '' }
  ];
  defaults.forEach((r) => {
    rooms.set(r.id, {
      id: r.id,
      name: r.name,
      isPrivate: r.isPrivate,
      password: r.password,
      users: new Map(),
      messages: []
    });
  });
}
createDefaultRooms();

function serializeRooms() {
  const list = [];
  for (const [, room] of rooms.entries()) {
    const roomUsers = Array.from(room.users.values()).map((u) => ({
      socketId: u.socketId,
      name: u.name,
      nick: u.nick,
      avatarColor: u.avatarColor,
      isMuted: Boolean(u.isMuted),
      isDeafened: Boolean(u.isDeafened),
      isStreaming: Boolean(u.isStreaming),
      voiceStreamId: u.voiceStreamId || null,
      screenStreamId: u.screenStreamId || null,
      streamConfig: u.streamConfig || null
    }));
    list.push({
      id: room.id,
      name: room.name,
      isPrivate: room.isPrivate,
      userCount: roomUsers.length,
      users: roomUsers
    });
  }
  return list;
}

// ================= ROTAS DO SITE OFICIAL, VERSÃO WEB E DOWNLOAD =================
app.get('/api/status', (_req, res) => {
  let activeStreams = 0;
  for (const [, u] of users.entries()) {
    if (u.isStreaming) activeStreams += 1;
  }
  res.json({
    ok: true,
    version: RELEASE_VERSION,
    onlineUsers: users.size,
    totalRooms: rooms.size,
    activeStreams,
    serverStatus: 'online'
  });
});

app.get('/download/windows', (_req, res) => {
  const localInstaller = path.join(PUBLIC_DIR, 'downloads', 'Aether.Setup.exe');
  if (fs.existsSync(localInstaller)) {
    res.download(localInstaller, 'Aether.Setup.exe');
    return;
  }
  res.redirect(302, GITHUB_RELEASE_EXE_URL);
});

app.get('/app', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/site', (_req, res) => {
  const landingPath = path.join(PUBLIC_DIR, 'landing.html');
  if (fs.existsSync(landingPath)) {
    res.sendFile(landingPath);
  } else {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
});

app.get('/', (req, res) => {
  const ua = String(req.headers['user-agent'] || '');
  const isElectronDesktop = ua.includes('Electron');
  const forceWebApp = req.query.app === '1' || req.query.mode === 'web';
  const landingPath = path.join(PUBLIC_DIR, 'landing.html');

  if (isElectronDesktop || forceWebApp || !fs.existsSync(landingPath)) {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    return;
  }
  res.sendFile(landingPath);
});

app.use(express.static(PUBLIC_DIR, { index: false }));

// ================= MOTOR SOCKET.IO + RELAY DE VOZ HÍBRIDO =================
io.on('connection', (socket) => {
  socket.on('user:register', (payload, cb) => {
    const cleanName = String(payload?.name || 'Utilizador').trim().slice(0, 28) || 'Utilizador';
    const cleanNick = String(payload?.nick || 'user').trim().replace(/[^a-zA-Z0-9_]/g, '').toLowerCase().slice(0, 20) || 'user';
    const avatarColor = String(payload?.avatarColor || '#5E81F4');

    const existing = users.get(socket.id) || {};
    const userObj = {
      ...existing,
      socketId: socket.id,
      name: cleanName,
      nick: cleanNick,
      avatarColor,
      roomId: existing.roomId || null,
      isMuted: Boolean(existing.isMuted),
      isDeafened: Boolean(existing.isDeafened),
      isStreaming: Boolean(existing.isStreaming),
      voiceStreamId: existing.voiceStreamId || null,
      screenStreamId: existing.screenStreamId || null,
      streamConfig: existing.streamConfig || null
    };

    users.set(socket.id, userObj);

    if (typeof cb === 'function') {
      cb({
        ok: true,
        user: userObj,
        rooms: serializeRooms()
      });
    }
    io.emit('rooms:update', serializeRooms());
  });

  socket.on('room:create', ({ name, isPrivate, password }, cb) => {
    const user = users.get(socket.id);
    if (!user) return cb?.({ ok: false, error: 'Utilizador não autenticado.' });

    const cleanRoomName = String(name || '').trim().slice(0, 36);
    if (cleanRoomName.length < 2) {
      return cb?.({ ok: false, error: 'Nome de sala inválido.' });
    }

    const roomId =
      cleanRoomName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') +
      '-' +
      Math.random().toString(36).slice(2, 6);

    rooms.set(roomId, {
      id: roomId,
      name: cleanRoomName,
      isPrivate: Boolean(isPrivate),
      password: Boolean(isPrivate) ? String(password || '') : '',
      users: new Map(),
      messages: []
    });

    io.emit('rooms:update', serializeRooms());
    cb?.({ ok: true, roomId });
  });

  socket.on('room:join', ({ roomId, password }, cb) => {
    const user = users.get(socket.id);
    const targetRoom = rooms.get(roomId);

    if (!user || !targetRoom) {
      return cb?.({ ok: false, error: 'Espaço não encontrado.' });
    }

    if (targetRoom.isPrivate && targetRoom.password !== String(password || '')) {
      return cb?.({ ok: false, error: 'Palavra-passe incorreta.' });
    }

    if (user.roomId && rooms.has(user.roomId)) {
      const prevRoom = rooms.get(user.roomId);
      prevRoom.users.delete(socket.id);
      socket.leave(user.roomId);
      socket.to(user.roomId).emit('peer:left', { socketId: socket.id });
    }

    user.roomId = roomId;
    user.isStreaming = false;
    user.screenStreamId = null;
    user.streamConfig = null;
    targetRoom.users.set(socket.id, user);
    socket.join(roomId);

    socket.to(roomId).emit('peer:joined', { user });

    const serializedRoomUsers = Array.from(targetRoom.users.values());
    cb?.({
      ok: true,
      room: {
        id: targetRoom.id,
        name: targetRoom.name,
        isPrivate: targetRoom.isPrivate,
        users: serializedRoomUsers,
        messages: targetRoom.messages.slice(-80)
      }
    });

    io.emit('rooms:update', serializeRooms());
  });

  socket.on('user:state-change', (patch) => {
    const user = users.get(socket.id);
    if (!user || !patch || typeof patch !== 'object') return;

    if (typeof patch.name === 'string' && patch.name.trim().length >= 2) {
      user.name = patch.name.trim().slice(0, 28);
    }
    if (typeof patch.nick === 'string' && patch.nick.trim().length >= 2) {
      user.nick = patch.nick.trim().replace(/[^a-zA-Z0-9_]/g, '').toLowerCase().slice(0, 20);
    }
    if (typeof patch.isMuted === 'boolean') user.isMuted = patch.isMuted;
    if (typeof patch.isDeafened === 'boolean') user.isDeafened = patch.isDeafened;
    if (typeof patch.isStreaming === 'boolean') user.isStreaming = patch.isStreaming;
    if (patch.voiceStreamId !== undefined) user.voiceStreamId = patch.voiceStreamId;
    if (patch.screenStreamId !== undefined) user.screenStreamId = patch.screenStreamId;
    if (patch.streamConfig !== undefined) user.streamConfig = patch.streamConfig;

    if (user.roomId && rooms.has(user.roomId)) {
      const room = rooms.get(user.roomId);
      room.users.set(socket.id, user);
      socket.to(user.roomId).emit('peer:state-updated', {
        socketId: socket.id,
        patch
      });
    }

    io.emit('rooms:update', serializeRooms());
  });

  socket.on('webrtc:signal', ({ to, data }) => {
    const sender = users.get(socket.id);
    if (!to || !data) return;
    io.to(to).emit('webrtc:signal', {
      from: socket.id,
      user: sender || null,
      data
    });
  });

  // Relay Automático de Voz para pares bloqueados por CGNAT estrito (até p2pVoiceOk = true)
  socket.on('voice:relay', (payload) => {
    const sender = users.get(socket.id);
    if (!sender || !sender.roomId || sender.isMuted || !payload?.pcm) return;

    const targets = Array.isArray(payload.targets) ? payload.targets : [];
    if (targets.length > 0) {
      targets.forEach((targetId) => {
        if (targetId && targetId !== socket.id) {
          io.to(targetId).volatile.emit('voice:relay', {
            from: socket.id,
            pcm: payload.pcm,
            sampleRate: payload.sampleRate || 16000
          });
        }
      });
    } else {
      socket.to(sender.roomId).volatile.emit('voice:relay', {
        from: socket.id,
        pcm: payload.pcm,
        sampleRate: payload.sampleRate || 16000
      });
    }
  });

  socket.on('chat:message', (payload) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId || !rooms.has(user.roomId)) return;

    const room = rooms.get(user.roomId);
    const text = String(payload?.text || '').trim().slice(0, 1000);
    const file = payload?.file || null;
    if (!text && !file) return;

    const msg = {
      id: 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7),
      senderId: socket.id,
      senderName: user.name,
      senderNick: user.nick,
      avatarColor: user.avatarColor,
      text,
      file,
      replyTo: payload?.replyTo || null,
      createdAt: Date.now(),
      timestamp: new Date().toLocaleTimeString('pt-PT', { hour: '2-digit', minute: '2-digit' }),
      edited: false
    };

    room.messages.push(msg);
    if (room.messages.length > 120) room.messages.shift();

    io.to(user.roomId).emit('chat:new-message', msg);
  });

  socket.on('chat:edit-message', ({ messageId, newText }, cb) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId || !rooms.has(user.roomId)) return cb?.({ ok: false });

    const room = rooms.get(user.roomId);
    const msg = room.messages.find((m) => m.id === messageId);
    if (!msg || msg.senderId !== socket.id) return cb?.({ ok: false });
    if (Date.now() - (msg.createdAt || 0) > 15 * 60 * 1000) return cb?.({ ok: false });

    const cleaned = String(newText || '').trim().slice(0, 1000);
    if (!cleaned) return cb?.({ ok: false });

    msg.text = cleaned;
    msg.edited = true;
    io.to(user.roomId).emit('chat:message-edited', { messageId, newText: cleaned });
    cb?.({ ok: true });
  });

  socket.on('chat:delete-message', ({ messageId }) => {
    const user = users.get(socket.id);
    if (!user || !user.roomId || !rooms.has(user.roomId)) return;

    const room = rooms.get(user.roomId);
    const idx = room.messages.findIndex((m) => m.id === messageId);
    if (idx === -1) return;

    const msg = room.messages[idx];
    if (msg.senderId !== socket.id) return;
    if (Date.now() - (msg.createdAt || 0) > 15 * 60 * 1000) return;

    room.messages.splice(idx, 1);
    io.to(user.roomId).emit('chat:message-deleted', { messageId });
  });

  socket.on('disconnect', () => {
    const user = users.get(socket.id);
    if (user) {
      if (user.roomId && rooms.has(user.roomId)) {
        const room = rooms.get(user.roomId);
        room.users.delete(socket.id);
        socket.to(user.roomId).emit('peer:left', { socketId: socket.id });
      }
      users.delete(socket.id);
      io.emit('rooms:update', serializeRooms());
    }
  });
});

const PORT = process.env.PORT || 10000;
server.listen(PORT, () => {
  console.log('====================================================');
  console.log(`🚀 AETHER REALTIME ENGINE ATIVO NA PORTA ${PORT}`);
  console.log(`🌐 Site Oficial: http://localhost:${PORT}/site`);
  console.log(`💻 Versão Web:   http://localhost:${PORT}/app`);
  console.log('====================================================');
});
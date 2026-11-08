const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const rooms = new Map();

io.on('connection', (socket) => {

  socket.on('create_room', ({ sessionToken }) => {
    // Безопасный UUIDv4 или фоллбэк
    const roomId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');

    rooms.set(roomId, {
      users: new Map(), // socket.id -> sessionToken
      graceTimers: new Map(), // sessionToken -> timer ID
      status: 'WAITING'
    });

    socket.join(roomId);
    socket.roomId = roomId;
    socket.sessionToken = sessionToken;
    rooms.get(roomId).users.set(socket.id, sessionToken);

    socket.emit('room_created', { roomId });
  });

  socket.on('join_room', ({ roomId, sessionToken }) => {
    const room = rooms.get(roomId);

    if (!room) {
      return socket.emit('error_message', 'Чат не найден или уже уничтожен.');
    }

    if (room.graceTimers.has(sessionToken)) {
      clearTimeout(room.graceTimers.get(sessionToken));
      room.graceTimers.delete(sessionToken);
      io.to(roomId).emit('chat_ready', { message: 'Собеседник вернулся в чат.' });
    }

    const activeTokens = new Set(room.users.values());
    
    if (activeTokens.size >= 2 && !activeTokens.has(sessionToken)) {
      io.to(roomId).emit('security_breach', 'Обнаружена попытка стороннего подключения! Чат уничтожается.');
      rooms.delete(roomId);
      return socket.emit('error_message', 'Доступ запрещен. Комната заблокирована.');
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.sessionToken = sessionToken;
    room.users.set(socket.id, sessionToken);

    if (new Set(room.users.values()).size === 2) {
      room.status = 'LOCKED';
      io.to(roomId).emit('chat_ready', { message: 'Собеседник подключился. Чат защищен.' });
    } else {
      socket.emit('joined_waiting');
    }
  });

  socket.on('send_encrypted_message', (encryptedData) => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('receive_encrypted_message', encryptedData);
  });

  socket.on('destroy_room_manual', () => {
    const roomId = socket.roomId;
    if (!roomId) return;
    
    // Оповещаем собеседника
    socket.to(roomId).emit('room_destroyed', 'Чат уничтожен собеседником.');
    
    // Удаляем из памяти сервера
    rooms.delete(roomId);
    
    // Принудительно выкидываем сокеты из комнаты
    io.in(roomId).socketsLeave(roomId);
  });

  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    const token = socket.sessionToken || room.users.get(socket.id);
    room.users.delete(socket.id);

    // Если никого не осталось
    if (room.users.size === 0) {
      rooms.delete(roomId);
      return;
    }

    // Запускаем таймер на 3 минуты для оставшегося собеседника
    if (token) {
      io.to(roomId).emit('peer_paused', { message: 'Собеседник временно недоступен. Ожидание: 3 мин.' });

      const timer = setTimeout(() => {
        io.to(roomId).emit('room_destroyed', 'Время ожидания переподключения истекло. Чат уничтожен.');
        rooms.delete(roomId);
      }, 180000);

      room.graceTimers.set(token, timer);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

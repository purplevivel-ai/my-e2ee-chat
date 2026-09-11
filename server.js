const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static('public'));

// Оперативная память сервера (RAM) для хранения состояния комнат
// Данные затираются при перезапуске сервера или автоуничтожении комнаты
const rooms = new Map();

io.on('connection', (socket) => {

  // 1. Создание комнаты
  socket.on('create_room', () => {
    let roomId;
    do {
      roomId = Math.floor(1000 + Math.random() * 9000).toString(); // 4-значный ID
    } while (rooms.has(roomId));

    rooms.set(roomId, {
      users: new Map(), // socketId -> { nick, status }
      graceTimers: new Map(),
      status: 'WAITING'
    });

    socket.join(roomId);
    socket.roomId = roomId;
    rooms.get(roomId).users.set(socket.id, { status: 'ACTIVE' });

    socket.emit('room_created', { roomId });
  });

  // 2. Вход в комнату
  socket.on('join_room', ({ roomId, nick }) => {
    const room = rooms.get(roomId);

    if (!room) {
      return socket.emit('error_message', 'Чат не найден или уже уничтожен.');
    }

    // Защита от 3-го лишнего (Breach Protection)
    if (room.users.size >= 2 && !room.users.has(socket.id)) {
      // Отправляем легитимным участникам сигнал тревоги на уничтожение
      io.to(roomId).emit('security_breach', 'Обнаружена попытка стороннего подключения! Чат уничтожается.');
      rooms.delete(roomId);
      return socket.emit('error_message', 'Доступ запрещен. Комната заблокирована.');
    }

    // Если пользователь переподключается во время Grace Period
    if (room.graceTimers.has(socket.id)) {
      clearTimeout(room.graceTimers.get(socket.id));
      room.graceTimers.delete(socket.id);
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.nick = nick;
    room.users.set(socket.id, { nick, status: 'ACTIVE' });

    if (room.users.size === 2) {
      room.status = 'LOCKED';
      io.to(roomId).emit('chat_ready', { message: 'Собеседник подключился. Чат защищен.' });
    } else {
      socket.emit('joined_waiting');
    }
  });

  // 3. Ретрансляция зашифрованных сообщений
  socket.on('send_encrypted_message', (encryptedData) => {
    if (!socket.roomId) return;
    // Сервер пересылает зашифрованный пакет всем участникам комнаты
    socket.to(socket.roomId).emit('receive_encrypted_message', encryptedData);
  });

  // 4. Ручная команда «Уничтожить чат»
  socket.on('destroy_room_manual', () => {
    if (!socket.roomId) return;
    io.to(socket.roomId).emit('room_destroyed', 'Чат уничтожен одним из участников.');
    rooms.delete(socket.roomId);
  });

  // 5. Обработка разрыва связи (Grace Period на 3 минуты для звонков и фонового режима)
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    room.users.delete(socket.id);

    // Если в чате никого не осталось — моментально удаляем комнату
    if (room.users.size === 0) {
      rooms.delete(roomId);
      return;
    }

    // Уведомляем оставшегося пользователя и запускаем таймер на 180 секунд (3 минуты)
    io.to(roomId).emit('peer_paused', { message: 'Собеседник временно недоступен (входящий звонок/сворачивание). Ожидание: 3 мин.' });

    const timer = setTimeout(() => {
      io.to(roomId).emit('room_destroyed', 'Время ожидания переподключения истекло. Чат уничтожен.');
      rooms.delete(roomId);
    }, 180000); // 3 минуты

    room.graceTimers.set(socket.id, timer);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

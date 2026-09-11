const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const rooms = new Map();

io.on('connection', (socket) => {

  // 1. Создание комнаты
  socket.on('create_room', () => {
    let roomId;
    do {
      roomId = Math.floor(1000 + Math.random() * 9000).toString();
    } while (rooms.has(roomId));

    rooms.set(roomId, {
      users: new Map(), // socketId -> nick
      graceTimers: new Map(), // nick -> timer
      status: 'WAITING'
    });

    socket.join(roomId);
    socket.roomId = roomId;
    socket.nick = 'Создатель';
    rooms.get(roomId).users.set(socket.id, socket.nick);

    socket.emit('room_created', { roomId });
  });

  // 2. Вход / Переподключение к комнате
  socket.on('join_room', ({ roomId, nick }) => {
    const room = rooms.get(roomId);

    if (!room) {
      return socket.emit('error_message', 'Чат не найден или уже уничтожен.');
    }

    // Отменяем таймер Grace Period, если пользователь возвращается
    if (room.graceTimers.has(nick)) {
      clearTimeout(room.graceTimers.get(nick));
      room.graceTimers.delete(nick);
      io.to(roomId).emit('chat_ready', { message: `${nick} вернулся в чат.` });
    }

    // Защита от 3-го лишнего (учитываем уникальные никнеймы/участники)
    const activeNicks = new Set(room.users.values());
    if (activeNicks.size >= 2 && !activeNicks.has(nick)) {
      io.to(roomId).emit('security_breach', 'Обнаружена попытка стороннего подключения! Чат уничтожается.');
      rooms.delete(roomId);
      return socket.emit('error_message', 'Доступ запрещен. Комната заблокирована.');
    }

    socket.join(roomId);
    socket.roomId = roomId;
    socket.nick = nick;
    room.users.set(socket.id, nick);

    if (new Set(room.users.values()).size === 2) {
      room.status = 'LOCKED';
      io.to(roomId).emit('chat_ready', { message: 'Собеседник подключился. Чат защищен.' });
    } else {
      socket.emit('joined_waiting');
    }
  });

  // 3. Ретрансляция зашифрованных сообщений
  socket.on('send_encrypted_message', (encryptedData) => {
    if (!socket.roomId) return;
    socket.to(socket.roomId).emit('receive_encrypted_message', encryptedData);
  });

  // 4. Ручное уничтожение
  socket.on('destroy_room_manual', () => {
    if (!socket.roomId) return;
    io.to(socket.roomId).emit('room_destroyed', 'Чат уничтожен одним из участников.');
    rooms.delete(socket.roomId);
  });

  // 5. Разрыв связи (Grace Period)
  socket.on('disconnect', () => {
    const roomId = socket.roomId;
    if (!roomId || !rooms.has(roomId)) return;

    const room = rooms.get(roomId);
    const userNick = socket.nick || room.users.get(socket.id);
    room.users.delete(socket.id);

    // Если в комнате вообще никого не осталось
    if (room.users.size === 0) {
      rooms.delete(roomId);
      return;
    }

    // Запускаем 3-минутный Grace Period для ушедшего ника
    if (userNick) {
      io.to(roomId).emit('peer_paused', { message: `${userNick} временно недоступен. Ожидание: 3 мин.` });

      const timer = setTimeout(() => {
        io.to(roomId).emit('room_destroyed', 'Время ожидания переподключения истекло. Чат уничтожен.');
        rooms.delete(roomId);
      }, 180000); // 180 сек

      room.graceTimers.set(userNick, timer);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

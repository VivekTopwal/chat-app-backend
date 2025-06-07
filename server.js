const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const Message = require('./models/Message');
const User = require('./models/User');

const app = express();
const server = http.createServer(app);
const uploadRoutes = require('./routes/upload');


const APP_URL = process.env.FRONTEND_URL;
// For Socket.IO
const io = socketIo(server, {
  cors: {
    origin: [`${APP_URL}`], 
    methods: ["GET", "POST"],
    credentials: true
  }
});

// For Express middleware
app.use(cors({
  origin:[`${APP_URL}`],
  credentials: true
}));

app.use(express.json());

app.use('/api/auth', require('./routes/auth'));
app.use('/api/upload', uploadRoutes);

app.use('/api/users', require('./routes/user'));
app.use('/uploads', express.static('uploads'));

// === Socket Setup ===
const connectedUsers = new Map(); // Map<socket.id, {userId, username, room}>
const onlineUsers = new Map();    // Map<username, socket.id>

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join', async (userData) => {
    try {
      connectedUsers.set(socket.id, {
        userId: userData.userId,
        username: userData.username,
        room: userData.room || 'general'
      });
      onlineUsers.set(userData.username, socket.id);
      socket.username = userData.username;
      socket.userId = userData.userId;

      socket.join(userData.room || 'general');

      await User.findByIdAndUpdate(userData.userId, {
        isOnline: true,
        lastSeen: new Date()
      });

      socket.to(userData.room || 'general').emit('userJoined', {
        username: userData.username,
        message: `${userData.username} joined the chat`
      });

      const recentMessages = await Message.find({
        room: userData.room || 'general'
      })
        .populate('sender', 'username avatar')
        .sort({ createdAt: -1 })
        .limit(50);

      socket.emit('recentMessages', recentMessages.reverse());
      io.emit('updateUserList', Array.from(onlineUsers.keys()));
    } catch (error) {
      console.error('Join error:', error);
    }
  });

  socket.on('sendMessage', async (messageData) => {
    try {
      const userInfo = connectedUsers.get(socket.id);
      if (!userInfo) return;

      const message = new Message({
        sender: userInfo.userId,
        content: messageData.content,
        room: messageData.room || 'general'
      });

      await message.save();
      await message.populate('sender', 'username avatar');

      io.to(messageData.room || 'general').emit('newMessage', {
        _id: message._id,
        content: message.content,
        sender: message.sender,
        room: message.room,
        createdAt: message.createdAt
      });
    } catch (error) {
      console.error('Send message error:', error);
    }
  });

  socket.on('typing', (data) => {
  const userInfo = connectedUsers.get(socket.id);
  if (!userInfo) return;

  if (data.to) {
    // Private chat typing
    const targetSocketId = onlineUsers.get(data.to);
    if (targetSocketId) {
      io.to(targetSocketId).emit('privateTyping', {
        from: userInfo.username,
        isTyping: data.isTyping
      });
    }
  } else {
    // Public/general chat typing
    const room = data.room || 'general';
    socket.to(room).emit('userTyping', {
      username: userInfo.username,
      isTyping: data.isTyping
    });
  }
});


  // 🔒 Private Messaging
  socket.on('privateMessage', ({ to, message, messageId }) => {
    const toSocketId = onlineUsers.get(to);
    if (toSocketId) {
      io.to(toSocketId).emit('privateMessage', {
        from: socket.username,
        message,
        timestamp: new Date(),
        messageId
      });
      console.log(`Private message from ${socket.username} to ${to}: ${message}`);
    } else {
      console.log(`User ${to} not found or offline`);
    }

    // Don't echo to sender - frontend handles this
  });

  // 🔒 Message Read Receipts
  socket.on('messageRead', ({ from, to }) => {
    console.log(`Message read event: ${from} read message from ${to}`);
    
    const senderSocketId = onlineUsers.get(to);
    if (senderSocketId) {
      io.to(senderSocketId).emit('messageRead', {
        from: from, // who read the message
        to: to      // who sent the original message
      });
      console.log(`Read receipt sent to ${to}`);
    } else {
      console.log(`Sender ${to} not online to receive read receipt`);
    }
  });

  socket.on('disconnect', async () => {
    const userInfo = connectedUsers.get(socket.id);
    if (userInfo) {
      await User.findByIdAndUpdate(userInfo.userId, {
        isOnline: false,
        lastSeen: new Date()
      });

      socket.to(userInfo.room).emit('userLeft', {
        username: userInfo.username,
        message: `${userInfo.username} left the chat`
      });

      connectedUsers.delete(socket.id);
      onlineUsers.delete(userInfo.username);

      io.emit('updateUserList', Array.from(onlineUsers.keys()));
      console.log(`${userInfo.username} disconnected`);
    }
  });
});

// === MongoDB Connection ===
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB connected'))
  .catch(err => console.log('MongoDB error:', err));

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
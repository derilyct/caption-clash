require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { createRoom, getRoom, deleteRoom } = require('./game');
const { router: authRouter, verifyToken } = require('./auth');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6,
});

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api/auth', authRouter);

// Track which room each socket is in
const socketRooms = new Map(); // socketId -> roomCode

// Authenticate sockets via JWT
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token) {
    const decoded = verifyToken(token);
    if (decoded) {
      socket.userId = decoded.userId;
    }
  }
  next();
});

io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);

  // --- Create a new game room ---
  socket.on('create-room', (data, callback) => {
    const game = createRoom();
    const userId = socket.userId || null;
    let totalWins = 0;
    if (userId) {
      const dbUser = db.findById(userId);
      if (dbUser) totalWins = dbUser.wins;
    }
    const result = game.addPlayer(socket.id, data.username, userId, totalWins);
    if (!result.success) {
      deleteRoom(game.roomCode);
      return callback({ success: false, error: result.error });
    }

    socket.join(game.roomCode);
    socketRooms.set(socket.id, game.roomCode);

    callback({
      success: true,
      roomCode: game.roomCode,
      player: result.player,
      players: game.getPlayerList(),
    });
  });

  // --- Join an existing room ---
  socket.on('join-room', (data, callback) => {
    const code = data.roomCode?.toUpperCase();
    const game = getRoom(code);

    if (!game) {
      return callback({ success: false, error: 'Room not found' });
    }

    const result = game.addPlayer(socket.id, data.username, socket.userId || null, (() => {
      if (socket.userId) {
        const u = db.findById(socket.userId);
        return u ? u.wins : 0;
      }
      return 0;
    })());
    if (!result.success) {
      return callback({ success: false, error: result.error });
    }

    socket.join(code);
    socketRooms.set(socket.id, code);

    // Notify other players
    socket.to(code).emit('player-joined', {
      player: result.player,
      players: game.getPlayerList(),
    });

    callback({
      success: true,
      roomCode: code,
      player: result.player,
      players: game.getPlayerList(),
    });
  });

  // --- Start the game (host only) ---
  socket.on('start-game', async (_, callback) => {
    const code = socketRooms.get(socket.id);
    const game = getRoom(code);

    if (!game) return callback({ success: false, error: 'No game found' });
    if (game.hostId !== socket.id) return callback({ success: false, error: 'Only the host can start' });
    if (game.players.size < 2) return callback({ success: false, error: 'Need at least 2 players' });

    try {
      const roundData = await game.startRound(
        // onTick
        (timeRemaining) => {
          io.to(code).emit('timer-tick', { timeRemaining, phase: game.state });
        },
        // onPhaseEnd
        (phase) => {
          if (phase === 'captioning') {
            transitionToVoting(code);
          }
        }
      );

      io.to(code).emit('round-start', roundData);
      callback({ success: true });
    } catch (err) {
      console.error('Error starting round:', err);
      callback({ success: false, error: 'Failed to start round' });
    }
  });

  // --- Submit a caption ---
  socket.on('submit-caption', (data, callback) => {
    const code = socketRooms.get(socket.id);
    const game = getRoom(code);

    if (!game) return callback({ success: false, error: 'No game found' });

    const result = game.submitCaption(socket.id, data.caption);
    if (!result.success) return callback(result);

    // Notify room about submission count
    io.to(code).emit('caption-submitted', {
      totalSubmitted: result.totalSubmitted,
      totalPlayers: result.totalPlayers,
      playerId: socket.id,
    });

    callback({ success: true });

    // If all captions are in, skip to voting
    if (result.allSubmitted) {
      game.clearTimer();
      transitionToVoting(code);
    }
  });

  // --- Submit a vote ---
  socket.on('submit-vote', (data, callback) => {
    const code = socketRooms.get(socket.id);
    const game = getRoom(code);

    if (!game) return callback({ success: false, error: 'No game found' });

    const result = game.submitVote(socket.id, data.captionAuthorId);
    if (!result.success) return callback(result);

    io.to(code).emit('vote-submitted', {
      totalVoted: result.totalVoted,
      totalVoters: result.totalVoters,
    });

    callback({ success: true });

    // If all votes are in, skip to results
    if (result.allVoted) {
      game.clearTimer();
      transitionToResults(code);
    }
  });

  // --- Next round (host only, after results) ---
  socket.on('next-round', async (_, callback) => {
    const code = socketRooms.get(socket.id);
    const game = getRoom(code);

    if (!game) return callback({ success: false, error: 'No game found' });
    if (game.hostId !== socket.id) return callback({ success: false, error: 'Only the host can advance' });

    try {
      const roundData = await game.startRound(
        (timeRemaining) => {
          io.to(code).emit('timer-tick', { timeRemaining, phase: game.state });
        },
        (phase) => {
          if (phase === 'captioning') {
            transitionToVoting(code);
          }
        }
      );

      io.to(code).emit('round-start', roundData);
      callback({ success: true });
    } catch (err) {
      console.error('Error starting next round:', err);
      callback({ success: false, error: 'Failed to start round' });
    }
  });

  // --- Play again (host only, after game over) ---
  socket.on('play-again', (_, callback) => {
    const code = socketRooms.get(socket.id);
    const game = getRoom(code);

    if (!game) return callback({ success: false, error: 'No game found' });
    if (game.hostId !== socket.id) return callback({ success: false, error: 'Only the host can restart' });

    game.resetGame();
    io.to(code).emit('game-reset', {
      players: game.getPlayerList(),
    });
    callback({ success: true });
  });

  // --- Leave game ---
  socket.on('leave-game', () => {
    handleDisconnect(socket);
  });

  // --- Disconnect ---
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
    handleDisconnect(socket);
  });
});

function transitionToVoting(code) {
  const game = getRoom(code);
  if (!game) return;

  // If fewer than 2 captions, skip voting
  if (game.captions.size < 2) {
    io.to(code).emit('round-skipped', {
      reason: 'Not enough captions submitted',
      scoreboard: game.getScoreboard(),
    });
    game.state = 'results';
    return;
  }

  const votingData = game.startVoting(
    (timeRemaining) => {
      io.to(code).emit('timer-tick', { timeRemaining, phase: 'voting' });
    },
    (phase) => {
      if (phase === 'voting') {
        transitionToResults(code);
      }
    }
  );

  io.to(code).emit('voting-start', votingData);
}

function transitionToResults(code) {
  const game = getRoom(code);
  if (!game) return;

  const results = game.getResults();

  // Persist win to database for logged-in winner
  if (results.gameWinner) {
    const winnerPlayer = game.players.get(results.gameWinner.id);
    if (winnerPlayer && winnerPlayer.userId) {
      db.incrementWins(winnerPlayer.userId);
      winnerPlayer.totalWins++;
    }
  }

  io.to(code).emit('round-results', results);
}

function handleDisconnect(socket) {
  const code = socketRooms.get(socket.id);
  if (!code) return;

  const game = getRoom(code);
  if (game) {
    const remaining = game.removePlayer(socket.id);
    socket.leave(code);
    socketRooms.delete(socket.id);

    if (remaining === 0) {
      deleteRoom(code);
    } else {
      io.to(code).emit('player-left', {
        playerId: socket.id,
        players: game.getPlayerList(),
        newHostId: game.hostId,
      });
    }
  } else {
    socketRooms.delete(socket.id);
  }
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Caption Clash running on http://localhost:${PORT}`);
});

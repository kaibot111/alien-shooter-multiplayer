const express = require('express');
const http = require('http');
const socketIo = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve the main game file
app.use(express.static(__dirname)); 
app.get('/', (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// --- Game Logic ---
const gridMax = 10;
let gameState = {
  players: {}, // Stores player scores and lives
  currentAlien: null,
  cannonYIntercept: 0
};

// Helper function from your code
function gcd(a, b) {
  a = Math.abs(a);
  b = Math.abs(b);
  if (b > a) { [a, b] = [b, a]; }
  while (b > 0) { [a, b] = [b, a % b]; }
  return a;
}

// This function now runs on the SERVER
function startNewRound() {
  let possibleTargets = [];
  
  // 1. Pick a random y-intercept for the cannon
  gameState.cannonYIntercept = Math.floor(Math.random() * (gridMax * 2 - 1)) - (gridMax - 1); // -9 to 9

  // 2. Pick a "nice" slope k
  let k_int = 0;
  while (k_int === 0) {
    k_int = Math.round((Math.random() * 10000) - 5000);
  }
  
  // 3. Find the base "rise" and "run"
  const commonDivisor = gcd(k_int, 1000);
  const baseX = 1000 / commonDivisor;
  const baseRise = k_int / commonDivisor;

  // 4. Find all points
  for (let n = 1; n <= gridMax * 2; n++) {
    let newX_pos = n * baseX;
    let newY_pos = (n * baseRise) + gameState.cannonYIntercept;
    if (Math.abs(newX_pos) <= gridMax && Math.abs(newY_pos) <= gridMax) {
      possibleTargets.push({ x: newX_pos, y: newY_pos });
    }
    
    let newX_neg = n * -baseX;
    let newY_neg = (n * -baseRise) + gameState.cannonYIntercept;
    if (Math.abs(newX_neg) <= gridMax && Math.abs(newY_neg) <= gridMax) {
      possibleTargets.push({ x: newX_neg, y: newY_neg });
    }
  }

  // 5. Remove duplicates
  possibleTargets = possibleTargets.filter((v, i, a) =>
    a.findIndex(t => (t.x === v.x && t.y === v.y)) === i
  );

  // 6. If no targets, retry
  if (possibleTargets.length === 0) {
    startNewRound();
    return;
  }
  
  // 7. Pick one alien for everyone
  const targetIndex = Math.floor(Math.random() * possibleTargets.length);
  gameState.currentAlien = possibleTargets[targetIndex];

  // 8. Tell everyone about the new round
  io.emit('newRound', {
    alien: gameState.currentAlien,
    b: gameState.cannonYIntercept
  });
  console.log(`New round started. Target: (${gameState.currentAlien.x}, ${gameState.currentAlien.y}), b: ${gameState.cannonYIntercept}`);
}

// --- Socket.io Connection Logic ---
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);
  
  // 1. Add new player
  gameState.players[socket.id] = {
    id: socket.id,
    name: `Player ${socket.id.substring(0, 4)}`,
    lives: 3,
    score: 0
  };
  
  // 2. If no game is running, start one
  if (gameState.currentAlien === null) {
    startNewRound();
  } else {
    // 3. If a game is running, send the current state to the new player
    socket.emit('newRound', {
      alien: gameState.currentAlien,
      b: gameState.cannonYIntercept
    });
  }
  
  // 4. Send the full player list to everyone
  io.emit('updatePlayers', gameState.players);

  // 5. Handle a player shooting
  socket.on('shoot', ({ k }) => {
    const player = gameState.players[socket.id];
    if (!player || player.lives <= 0 || !gameState.currentAlien) return; // Ignore dead players or if no alien
    
    const targetAlien = gameState.currentAlien;
    const alienSlope = (targetAlien.y - gameState.cannonYIntercept) / targetAlien.x;
    const isSlopeMatch = Math.abs(alienSlope - k) < 0.01;
    
    if (isSlopeMatch) {
      // --- HIT! ---
      player.score++;
      io.emit('hit', { 
        playerId: player.id,
        playerName: player.name,
        alien: targetAlien 
      });
      io.emit('updatePlayers', gameState.players);
      
      // Start next round after a short delay
      setTimeout(startNewRound, 1500);
      
    } else {
      // --- MISS! ---
      player.lives--;
      
      // Tell just this player about their miss
      socket.emit('myMiss', {
        yourSlope: k,
        correctSlope: alienSlope,
        lives: player.lives
      });
      
      // Tell everyone the player list updated (fewer lives)
      io.emit('updatePlayers', gameState.players);
      
      if (player.lives <= 0) {
        socket.emit('gameOver');
      }
    }
  });

  // 6. Handle a player disconnecting
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    delete gameState.players[socket.id];
    // Tell everyone the player list updated
    io.emit('updatePlayers', gameState.players);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
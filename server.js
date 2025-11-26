const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

// --- CRITICAL: Must be set in Render Environment Variables ---
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const SESSION_SECRET = process.env.SESSION_SECRET;
const BASE_URL = process.env.BASE_URL; // Your app's URL, e.g., https://my-game.onrender.com

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// --- 1. Session and Passport Setup ---
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: true,
});
app.use(sessionMiddleware);
app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: `${BASE_URL}/auth/google/callback`
  },
  (accessToken, refreshToken, profile, done) => {
    // In a real app, you'd save this profile to a database
    // For this simple game, we just pass the profile along.
    return done(null, profile);
  }
));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

// --- 2. Auth Routes ---
app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback', 
  passport.authenticate('google', { failureRedirect: '/' }),
  (req, res) => {
    // Successful authentication, redirect to the game.
    res.redirect('/');
  }
);

app.get('/auth/logout', (req, res) => {
  req.logout((err) => {
    if (err) { return next(err); }
    res.redirect('/');
  });
});

// --- 3. Middleware to Check Login ---
function ensureAuthenticated(req, res, next) {
  if (req.isAuthenticated()) { return next(); }
  // If not logged in, send a simple login page
  res.send(`
    <body style="font-family: sans-serif; text-align: center; background: #222; color: #eee; padding-top: 50px;">
      <h1>Welcome to Alien Slope Shooter</h1>
      <p>Please log in to play.</p>
      <a href="/auth/google" style="padding: 10px 20px; background: #4285F4; color: white; text-decoration: none; border-radius: 5px;">
        Sign in with Google
      </a>
    </body>
  `);
}

// --- 4. Game Routes ---
// All game routes are now protected
app.get('/', ensureAuthenticated, (req, res) => {
  res.sendFile(__dirname + '/index.html');
});

// API route to get the user's name
app.get('/api/me', ensureAuthenticated, (req, res) => {
  res.json({
    name: req.user.displayName,
    id: req.user.id
  });
});

// Make static files available
app.use(express.static(__dirname));

// --- 5. Game Logic (Now with Rooms) ---
const gridMax = 10;
let rooms = {}; // This will hold all active game rooms

function gcd(a, b) {
  a = Math.abs(a); b = Math.abs(b);
  if (b > a) { [a, b] = [b, a]; }
  while (b > 0) { [a, b] = [b, a % b]; }
  return a;
}

// This function now creates a new game STATE for a specific room
function createNewGameState() {
  let possibleTargets = [];
  let cannonYIntercept = Math.floor(Math.random() * (gridMax * 2 - 1)) - (gridMax - 1);
  let k_int = 0;
  while (k_int === 0) {
    k_int = Math.round((Math.random() * 10000) - 5000);
  }
  const commonDivisor = gcd(k_int, 1000);
  const baseX = 1000 / commonDivisor;
  const baseRise = k_int / commonDivisor;
  for (let n = 1; n <= gridMax * 2; n++) {
    let newX_pos = n * baseX;
    let newY_pos = (n * baseRise) + cannonYIntercept;
    if (Math.abs(newX_pos) <= gridMax && Math.abs(newY_pos) <= gridMax) {
      possibleTargets.push({ x: newX_pos, y: newY_pos });
    }
    let newX_neg = n * -baseX;
    let newY_neg = (n * -baseRise) + cannonYIntercept;
    if (Math.abs(newX_neg) <= gridMax && Math.abs(newY_neg) <= gridMax) {
      possibleTargets.push({ x: newX_neg, y: newY_neg });
    }
  }
  possibleTargets = possibleTargets.filter((v, i, a) =>
    a.findIndex(t => (t.x === v.x && t.y === v.y)) === i
  );

  if (possibleTargets.length === 0) {
    return createNewGameState(); // Retry if no targets
  }
  
  const targetIndex = Math.floor(Math.random() * possibleTargets.length);
  const currentAlien = possibleTargets[targetIndex];
  
  return {
    currentAlien: currentAlien,
    cannonYIntercept: cannonYIntercept
  };
}

// Helper to broadcast a new round to a specific room
function startNewRound(roomCode) {
  const newGameState = createNewGameState();
  rooms[roomCode].gameState = newGameState;
  
  io.to(roomCode).emit('newRound', {
    alien: newGameState.currentAlien,
    b: newGameState.cannonYIntercept
  });
  console.log(`New round started in room ${roomCode}`);
}

// --- 6. Socket.io (Now with Rooms) ---
io.on('connection', (socket) => {
  console.log('A user connected:', socket.id);
  let currentRoom = null;

  socket.on('createRoom', ({ name }) => {
    let roomCode;
    do {
      roomCode = Math.floor(1000 + Math.random() * 9000).toString();
    } while (rooms[roomCode]); // Ensure room code is unique

    currentRoom = roomCode;
    rooms[roomCode] = {
      players: {},
      gameState: null
    };
    
    rooms[roomCode].players[socket.id] = {
      id: socket.id,
      name: name,
      lives: 3,
      score: 0
    };
    
    socket.join(roomCode);
    console.log(`Player ${name} created and joined room ${roomCode}`);
    socket.emit('roomJoined', roomCode);
    io.to(roomCode).emit('updatePlayers', rooms[roomCode].players);
    startNewRound(roomCode);
  });
  
  socket.on('joinRoom', ({ roomCode, name }) => {
    const room = rooms[roomCode];
    if (!room) {
      return socket.emit('error', 'Room not found.');
    }
    
    currentRoom = roomCode;
    room.players[socket.id] = {
      id: socket.id,
      name: name,
      lives: 3,
      score: 0
    };
    
    socket.join(roomCode);
    console.log(`Player ${name} joined room ${roomCode}`);
    socket.emit('roomJoined', roomCode);
    socket.emit('newRound', room.gameState); // Send current game to new player
    io.to(roomCode).emit('updatePlayers', room.players);
  });

  socket.on('shoot', ({ k }) => {
    const room = rooms[currentRoom];
    if (!room) return;
    
    const player = room.players[socket.id];
    if (!player || player.lives <= 0 || !room.gameState.currentAlien) return;

    const { currentAlien, cannonYIntercept } = room.gameState;
    const alienSlope = (currentAlien.y - cannonYIntercept) / currentAlien.x;
    const isSlopeMatch = Math.abs(alienSlope - k) < 0.01;
    
    if (isSlopeMatch) {
      player.score++;
      io.to(currentRoom).emit('hit', { 
        playerId: player.id,
        playerName: player.name,
        alien: currentAlien 
      });
      io.to(currentRoom).emit('updatePlayers', room.players);
      setTimeout(() => startNewRound(currentRoom), 1500);
      
    } else {
      player.lives--;
      socket.emit('myMiss', {
        yourSlope: k,
        correctSlope: alienSlope,
        lives: player.lives
      });
      io.to(currentRoom).emit('updatePlayers', room.players);
      if (player.lives <= 0) {
        socket.emit('gameOver');
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const room = rooms[currentRoom];
    if (room) {
      delete room.players[socket.id];
      if (Object.keys(room.players).length === 0) {
        // Delete room if empty
        delete rooms[currentRoom];
        console.log(`Room ${currentRoom} deleted.`);
      } else {
        // Otherwise, just update the players
        io.to(currentRoom).emit('updatePlayers', room.players);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
});

app.use(express.static("public"));

const rooms = new Map();

const COLORS = ["RED", "BLUE", "GREEN", "YELLOW", "PURPLE", "CYAN"];
const SHAPES = ["▲", "●", "■", "◆", "★", "✚"];
const WORDS = ["ALPHA", "ORBIT", "GHOST", "NEON", "MIRROR", "VORTEX", "PULSE", "STATIC"];

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function makeRound() {
  const aWord = rand(COLORS);
  const aShape = rand(SHAPES);
  const bWord = rand(WORDS);
  const lock = String(Math.floor(100 + Math.random() * 900));

  return {
    clueA: `${aWord} ${aShape}`,
    clueB: `${bWord}`,
    lock,
    signalType: Math.random() < 0.35 ? "fake" : "go",
    signalOpen: false,
    phase: "prep",
    stageEndsAt: Date.now() + 4500,
  };
}

function difficultyFor(room) {
  if (room.difficulty === "easy") {
    return { prep: 6000, signal: 2600, objective: 4, penalty: 1, fakeChance: 0.22 };
  }
  if (room.difficulty === "hard") {
    return { prep: 3200, signal: 1500, objective: 7, penalty: 2, fakeChance: 0.45 };
  }
  return { prep: 4500, signal: 2100, objective: 5, penalty: 1, fakeChance: 0.33 };
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    round: room.round,
    totalRounds: room.totalRounds,
    difficulty: room.difficulty,
    objective: room.objective,
    completed: room.completed,
    message: room.message,
    clueA: room.currentRound?.clueA ?? null,
    clueB: room.currentRound?.clueB ?? null,
    lock: room.currentRound?.lock ?? null,
    signalType: room.currentRound?.signalType ?? null,
    signalOpen: room.currentRound?.signalOpen ?? false,
    stageEndsAt: room.currentRound?.stageEndsAt ?? null,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
    })),
  };
}

function emitRoom(room) {
  io.to(room.code).emit("roomState", publicRoom(room));
}

function endGame(room, message) {
  room.phase = "ended";
  room.message = message;
  if (room.currentRound) room.currentRound.signalOpen = false;
  emitRoom(room);
}

function startResolveThenNext(room) {
  room.phase = "resolve";
  room.message = room.message || "Checking result...";
  if (room.currentRound) room.currentRound.signalOpen = false;
  emitRoom(room);

  setTimeout(() => {
    const fresh = rooms.get(room.code);
    if (!fresh) return;

    if (fresh.completed >= fresh.objective) {
      endGame(fresh, "Room escaped.");
      return;
    }

    if (fresh.round >= fresh.totalRounds) {
      endGame(
        fresh,
        fresh.completed >= Math.ceil(fresh.objective / 2) ? "Room escaped." : "Room locked."
      );
      return;
    }

    fresh.round += 1;
    startPrep(fresh);
  }, 1400);
}

function startSignal(room) {
  const cfg = difficultyFor(room);

  room.phase = "signal";
  room.currentRound.signalOpen = true;
  room.currentRound.stageEndsAt = Date.now() + cfg.signal;
  room.message = room.currentRound.signalType === "go" ? "GO!" : "FAKE SIGNAL!";
  emitRoom(room);

  setTimeout(() => {
    const fresh = rooms.get(room.code);
    if (!fresh || fresh.phase !== "signal" || !fresh.currentRound) return;

    fresh.currentRound.signalOpen = false;

    if (fresh.currentRound.signalType === "go") {
      fresh.message = "Too slow.";
    } else {
      fresh.message = "Fake signal expired safely.";
      fresh.completed += 1;
    }

    startResolveThenNext(fresh);
  }, cfg.signal);
}

function startPrep(room) {
  const cfg = difficultyFor(room);
  room.currentRound = makeRound();

  room.currentRound.signalType = Math.random() < cfg.fakeChance ? "fake" : "go";
  room.currentRound.signalOpen = false;
  room.currentRound.phase = "prep";
  room.currentRound.stageEndsAt = Date.now() + cfg.prep;
  room.phase = "prep";
  room.message = "Study the clues.";
  emitRoom(room);

  setTimeout(() => {
    const fresh = rooms.get(room.code);
    if (!fresh || fresh.phase === "ended") return;
    startSignal(fresh);
  }, cfg.prep);
}

io.on("connection", (socket) => {
  socket.on("createRoom", ({ name, difficulty, totalRounds }, cb) => {
    const code = makeCode();

    const room = {
      code,
      hostId: socket.id,
      phase: "lobby",
      round: 1,
      totalRounds: Math.max(1, Math.min(15, Number(totalRounds) || 5)),
      difficulty: ["easy", "normal", "hard"].includes(difficulty) ? difficulty : "normal",
      objective: difficultyFor({ difficulty: ["easy", "normal", "hard"].includes(difficulty) ? difficulty : "normal" }).objective,
      completed: 0,
      players: [{ id: socket.id, name: String(name || "Host").slice(0, 20), score: 0 }],
      currentRound: null,
      message: "Room created.",
    };

    rooms.set(code, room);
    socket.join(code);

    cb?.({ ok: true, code, state: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) return cb?.({ ok: false, error: "Room not found." });
    if (room.phase !== "lobby") return cb?.({ ok: false, error: "Game already started." });
    if (room.players.some((p) => p.id === socket.id)) return cb?.({ ok: true, state: publicRoom(room) });
    if (room.players.length >= 6) return cb?.({ ok: false, error: "Room is full." });

    room.players.push({
      id: socket.id,
      name: String(name || `Player ${room.players.length + 1}`).slice(0, 20),
      score: 0,
    });

    socket.join(code);
    cb?.({ ok: true, state: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("startGame", ({ code }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) return cb?.({ ok: false, error: "Room not found." });
    if (room.hostId !== socket.id) return cb?.({ ok: false, error: "Only the host can start." });
    if (room.players.length < 2) return cb?.({ ok: false, error: "Need at least 2 players." });

    room.phase = "starting";
    room.message = "Starting...";
    emitRoom(room);

    setTimeout(() => {
      const fresh = rooms.get(code);
      if (!fresh) return;
      fresh.round = 1;
      fresh.completed = 0;
      fresh.objective = difficultyFor(fresh).objective;
      startPrep(fresh);
      cb?.({ ok: true });
    }, 800);
  });

  socket.on("reaction", ({ code, type }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);

    if (!room || room.phase !== "signal" || !room.currentRound?.signalOpen) {
      return cb?.({ ok: false, error: "No active signal." });
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return cb?.({ ok: false, error: "Not in room." });

    const correct = room.currentRound.signalType === type;

    room.currentRound.signalOpen = false;
    room.phase = "resolve";

    if (correct) {
      const fastBonus = Math.max(0, Math.floor((room.currentRound.stageEndsAt - Date.now()) / 500));
      player.score += 1 + fastBonus;
      room.completed += 1;
      room.message = `${player.name} was correct!`;
      emitRoom(room);
      return setTimeout(() => startResolveThenNext(room), 900);
    }

    player.score = Math.max(0, player.score - difficultyFor(room).penalty);
    room.message = `${player.name} messed up.`;
    emitRoom(room);
    return setTimeout(() => startResolveThenNext(room), 900);
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      const idx = room.players.findIndex((p) => p.id === socket.id);
      if (idx === -1) continue;

      const wasHost = room.hostId === socket.id;
      room.players.splice(idx, 1);

      if (room.players.length === 0) {
        rooms.delete(code);
        continue;
      }

      if (wasHost) room.hostId = room.players[0].id;
      emitRoom(room);
    }
  });
});

app.get("/", (_, res) => {
  res.send("Signal Break server running.");
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on ${PORT}`));

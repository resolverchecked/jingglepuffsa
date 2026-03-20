const express = require("express");
const http    = require("http");
const { Server } = require("socket.io");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

const rooms = new Map();

// ── Clue vocabulary ──────────────────────────────────────────────────────────
const GO_COLORS   = ["RED", "ORANGE", "YELLOW", "WHITE"];
const FAKE_COLORS = ["BLUE", "GREEN", "PURPLE", "CYAN"];
const SHAPES      = ["▲", "●", "■", "◆", "★", "⬟", "⬡", "⬢"];

// Odd letter-count → GO | Even letter-count → FAKE
const GO_WORDS   = ["ARC","NEXUS","DELTA","SIGMA","ALPHA","BLAZE","PRISM","PULSE","GHOST","ORBIT","SLASH","SPARK","FLINT","CRUSH","SWIFT"];
const FAKE_WORDS = ["ECHO","NEON","FLUX","VOID","WIRE","NODE","LOCK","NOVA","ZERO","VORTEX","MIRROR","STATIC","VECTOR","CIPHER","FREEZE"];

// ── Powerup definitions ───────────────────────────────────────────────────────
// SHIELD  – next wrong reaction deals 0 penalty (auto)
// DOUBLE  – next correct reaction scores 2× (auto)
// BOOST   – extends signal window by +700ms for everyone (applies on claim)
// REVEAL  – server whispers the real signal type privately to the claimant
const POWERUP_TYPES = ["SHIELD", "DOUBLE", "BOOST", "REVEAL"];
const POWERUP_SPAWN_CHANCE = 0.40;  // 40% chance per round

const VALID_DIFFS = ["easy","normal","hard","impossible"];

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ── Progressive scaling ───────────────────────────────────────────────────────
function difficultyFor(room) {
  const round       = Math.max(1, room.round || 1);
  const roundFactor = Math.max(0.55, 1 - (round - 1) * 0.028);
  const fakeBoost   = Math.min(0.25, (round - 1) * 0.012);

  if (room.difficulty === "easy")
    return { prep: Math.round(6000 * roundFactor), signal: Math.round(2600 * roundFactor),
             objective: 4, penalty: 1, fakeChance: Math.min(0.50, 0.22 + fakeBoost) };

  if (room.difficulty === "hard")
    return { prep: Math.max(1200, Math.round(3200 * roundFactor)),
             signal: Math.max(600,  Math.round(1500 * roundFactor)),
             objective: 7, penalty: 2, fakeChance: Math.min(0.70, 0.45 + fakeBoost) };

  if (room.difficulty === "impossible") {
    const f = Math.max(0.30, 1 - (round - 1) * 0.048);
    return { prep:   Math.max(500, Math.round(2000 * f)),
             signal: Math.max(280, Math.round(800  * f)),
             objective: 10, penalty: 3, fakeChance: Math.min(0.88, 0.60 + fakeBoost * 1.8) };
  }
  // normal
  return { prep: Math.max(1600, Math.round(4500 * roundFactor)),
           signal: Math.max(800, Math.round(2100 * roundFactor)),
           objective: 5, penalty: 1, fakeChance: Math.min(0.60, 0.33 + fakeBoost) };
}

// ── Round modifier ────────────────────────────────────────────────────────────
function getRoundModifier(room) {
  const round   = room.round || 1;
  const diff    = room.difficulty;
  const rScale  = Math.min(0.18, (round - 1) * 0.012);
  const bombC   = ({ easy:0.07, normal:0.13, hard:0.20, impossible:0.28 }[diff] ?? 0.13) + rScale;
  const invertC = ({ easy:0.10, normal:0.20, hard:0.30, impossible:0.40 }[diff] ?? 0.20) + rScale;
  const doubleC = ({ easy:0.05, normal:0.10, hard:0.15, impossible:0.20 }[diff] ?? 0.10) + rScale * 0.5;
  const r = Math.random();
  if (r < bombC)                     return "bomb";
  if (r < bombC + invertC)           return "inverted";
  if (r < bombC + invertC + doubleC) return "double";
  return "normal";
}

// ── Clue builder ─────────────────────────────────────────────────────────────
function buildClues(realType, modifier) {
  if (modifier === "bomb") return { clueA: "ORANGE ✚", clueB: "ZERO", lock: "!!!" };
  const isGo  = realType === "go";
  const colour = rand(isGo ? GO_COLORS : FAKE_COLORS);
  const clueA  = `${colour} ${rand(SHAPES)}`;
  const clueB  = rand(isGo ? GO_WORDS : FAKE_WORDS);
  let lockNum;
  do { lockNum = Math.floor(100 + Math.random() * 900); }
  while ((lockNum % 2 === 0) !== (!isGo));
  return { clueA, clueB, lock: String(lockNum) };
}

// ── Powerup spawner ───────────────────────────────────────────────────────────
function maybeSpawnPowerup() {
  if (Math.random() > POWERUP_SPAWN_CHANCE) return null;
  return { type: rand(POWERUP_TYPES), claimedBy: null, claimedByName: null };
}

// ── Room snapshot ─────────────────────────────────────────────────────────────
function publicRoom(room) {
  return {
    code:          room.code,
    hostId:        room.hostId,
    phase:         room.phase,
    round:         room.round,
    totalRounds:   room.totalRounds,
    difficulty:    room.difficulty,
    objective:     room.objective,
    completed:     room.completed,
    message:       room.message,
    clueA:         room.currentRound?.clueA         ?? null,
    clueB:         room.currentRound?.clueB         ?? null,
    lock:          room.currentRound?.lock          ?? null,
    roundModifier: room.currentRound?.roundModifier ?? "normal",
    realSignal:    room.currentRound?.realSignal    ?? null,
    signalType:    room.currentRound?.signalType    ?? null,
    signalOpen:    room.currentRound?.signalOpen    ?? false,
    stageEndsAt:   room.currentRound?.stageEndsAt  ?? null,
    stageTotalMs:  room.currentRound?.stageTotalMs ?? null,
    doubleHit:     room.currentRound?.doubleHit    ?? 0,
    roundPowerup:  room.currentRound?.roundPowerup ?? null,
    players: room.players.map(p => ({
      id: p.id, name: p.name, score: p.score, heldPowerup: p.heldPowerup ?? null,
    })),
  };
}

function emitRoom(room) { io.to(room.code).emit("roomState", publicRoom(room)); }

function endGame(room, message) {
  room.phase = "ended"; room.message = message;
  if (room.currentRound) room.currentRound.signalOpen = false;
  emitRoom(room);
}

function startResolveThenNext(room) {
  room.phase = "resolve";
  if (room.currentRound) room.currentRound.signalOpen = false;
  emitRoom(room);
  setTimeout(() => {
    const fresh = rooms.get(room.code);
    if (!fresh) return;
    if (fresh.completed >= fresh.objective) { endGame(fresh, "Room escaped."); return; }
    if (fresh.round >= fresh.totalRounds) {
      endGame(fresh, fresh.completed >= Math.ceil(fresh.objective / 2) ? "Room escaped." : "Room locked.");
      return;
    }
    fresh.round += 1;
    startPrep(fresh);
  }, 1400);
}

function startSignal(room) {
  const cfg      = difficultyFor(room);
  const modifier = room.currentRound.roundModifier;
  const boostMs  = room.currentRound.boostApplied ? 700 : 0;
  const sigMs    = cfg.signal + boostMs;

  room.phase = "signal";
  room.currentRound.signalOpen   = true;
  room.currentRound.stageEndsAt  = Date.now() + sigMs;
  room.currentRound.stageTotalMs = sigMs;

  if (modifier === "bomb") {
    room.currentRound.signalType = "bomb";
    room.message = "💣 DEFUSE IT!";
  } else if (modifier === "inverted") {
    const real = room.currentRound.realSignal;
    room.currentRound.signalType = real;
    room.message = real === "go" ? "FAKE SIGNAL!" : "GO!";
  } else if (modifier === "double") {
    room.currentRound.signalType = "go";
    room.currentRound.doubleHit  = 0;
    room.message = "HIT TWICE! GO GO!";
  } else {
    room.message = room.currentRound.signalType === "go" ? "GO!" : "FAKE SIGNAL!";
  }

  emitRoom(room);

  setTimeout(() => {
    const fresh = rooms.get(room.code);
    if (!fresh || fresh.phase !== "signal" || !fresh.currentRound) return;
    fresh.currentRound.signalOpen = false;
    const mod = fresh.currentRound.roundModifier;
    if (mod === "bomb")                                          fresh.message = "💥 Bomb exploded.";
    else if (mod === "double" && (fresh.currentRound.doubleHit||0) < 2) fresh.message = "Too slow — needed two hits.";
    else if (mod === "double") return;
    else if (fresh.currentRound.signalType === "go")             fresh.message = "Too slow.";
    else { fresh.message = "Fake signal — held steady."; fresh.completed += 1; }
    startResolveThenNext(fresh);
  }, sigMs);
}

function startPrep(room) {
  const cfg      = difficultyFor(room);
  const modifier = getRoundModifier(room);

  let realSignal, signalType;
  if (modifier === "bomb") {
    realSignal = "bomb"; signalType = "bomb";
  } else {
    const isGo = Math.random() >= cfg.fakeChance;
    realSignal = isGo ? "go" : "fake"; signalType = isGo ? "go" : "fake";
  }

  const clues = buildClues(realSignal, modifier);

  room.currentRound = {
    ...clues,
    roundModifier: modifier,
    roundPowerup:  maybeSpawnPowerup(),
    signalOpen:    false,
    stageEndsAt:   Date.now() + cfg.prep,
    stageTotalMs:  cfg.prep,
    doubleHit:     0,
    boostApplied:  false,
    realSignal,
    signalType,
  };

  room.phase   = "prep";
  room.message = "Study the clues.";
  emitRoom(room);

  setTimeout(() => {
    const fresh = rooms.get(room.code);
    if (!fresh || fresh.phase === "ended") return;
    startSignal(fresh);
  }, cfg.prep);
}

// ── Socket handlers ───────────────────────────────────────────────────────────
io.on("connection", socket => {

  socket.on("createRoom", ({ name, difficulty, totalRounds }, cb) => {
    const diff = VALID_DIFFS.includes(difficulty) ? difficulty : "normal";
    const code = makeCode();
    const room = {
      code,
      hostId:      socket.id,
      phase:       "lobby",
      round:       1,
      totalRounds: Math.max(1, Math.min(25, Number(totalRounds) || 5)),
      difficulty:  diff,
      objective:   difficultyFor({ difficulty: diff, round: 1 }).objective,
      completed:   0,
      players:     [{ id: socket.id, name: String(name || "Host").slice(0,20), score: 0, heldPowerup: null }],
      currentRound: null,
      message:     "Room created.",
    };
    rooms.set(code, room);
    socket.join(code);
    cb?.({ ok: true, code, state: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room)                                       return cb?.({ ok: false, error: "Room not found." });
    if (room.phase !== "lobby")                      return cb?.({ ok: false, error: "Game already started." });
    if (room.players.some(p => p.id === socket.id)) return cb?.({ ok: true, state: publicRoom(room) });
    if (room.players.length >= 6)                    return cb?.({ ok: false, error: "Room is full." });
    room.players.push({ id: socket.id, name: String(name || `Player ${room.players.length+1}`).slice(0,20), score: 0, heldPowerup: null });
    socket.join(code);
    cb?.({ ok: true, state: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("startGame", ({ code }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room)                     return cb?.({ ok: false, error: "Room not found." });
    if (room.hostId !== socket.id) return cb?.({ ok: false, error: "Only the host can start." });
    if (room.players.length < 2)   return cb?.({ ok: false, error: "Need at least 2 players." });
    room.phase = "starting"; room.message = "Starting..."; emitRoom(room);
    setTimeout(() => {
      const fresh = rooms.get(code);
      if (!fresh) return;
      fresh.round = 1; fresh.completed = 0;
      fresh.players.forEach(p => p.heldPowerup = null);
      fresh.objective = difficultyFor({ difficulty: fresh.difficulty, round: 1 }).objective;
      startPrep(fresh);
      cb?.({ ok: true });
    }, 800);
  });

  // ── Claim powerup ──────────────────────────────────────────────────────────
  socket.on("claimPowerup", ({ code }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room || room.phase !== "prep" || !room.currentRound?.roundPowerup)
      return cb?.({ ok: false, error: "No powerup available." });

    const pu = room.currentRound.roundPowerup;
    if (pu.claimedBy) return cb?.({ ok: false, error: "Already claimed." });

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return cb?.({ ok: false, error: "Not in room." });

    pu.claimedBy     = socket.id;
    pu.claimedByName = player.name;

    if (pu.type === "BOOST") {
      // Extend signal window for this round
      room.currentRound.boostApplied = true;
      room.message = `${player.name} activated BOOST — signal window +700ms!`;
      emitRoom(room);
    } else if (pu.type === "REVEAL") {
      // Whisper the real signal privately to the claimant
      const real = room.currentRound.realSignal;
      socket.emit("powerupReveal", { realSignal: real });
      player.heldPowerup = null; // consumed immediately
      room.message = `${player.name} used REVEAL.`;
      emitRoom(room);
    } else {
      // SHIELD or DOUBLE — stored for use on next reaction
      player.heldPowerup = pu.type;
      room.message = `${player.name} grabbed ${pu.type}!`;
      emitRoom(room);
    }

    cb?.({ ok: true, type: pu.type });
  });

  // ── Reaction ───────────────────────────────────────────────────────────────
  socket.on("reaction", ({ code, type }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room || room.phase !== "signal" || !room.currentRound?.signalOpen)
      return cb?.({ ok: false, error: "No active signal." });

    const player = room.players.find(p => p.id === socket.id);
    if (!player) return cb?.({ ok: false, error: "Not in room." });

    const modifier = room.currentRound.roundModifier;
    const cfg      = difficultyFor(room);

    // ── DOUBLE ────────────────────────────────────────────────────────────────
    if (modifier === "double") {
      if (type !== "go") {
        room.currentRound.signalOpen = false;
        const shield = player.heldPowerup === "SHIELD";
        if (!shield) player.score = Math.max(0, player.score - cfg.penalty);
        if (shield)  player.heldPowerup = null;
        room.message = `${player.name} pressed wrong!${shield ? " (Shield absorbed it)" : ""}`;
        emitRoom(room);
        cb?.({ ok: false });
        return setTimeout(() => startResolveThenNext(room), 900);
      }
      room.currentRound.doubleHit = (room.currentRound.doubleHit || 0) + 1;
      emitRoom(room);
      if (room.currentRound.doubleHit < 2) {
        room.message = "ONE MORE!"; emitRoom(room);
        return cb?.({ ok: true, partial: true });
      }
      room.currentRound.signalOpen = false;
      const fastBonus = Math.max(0, Math.floor((room.currentRound.stageEndsAt - Date.now()) / 500));
      const dbl = player.heldPowerup === "DOUBLE";
      player.score += (2 + fastBonus) * (dbl ? 2 : 1);
      if (dbl) player.heldPowerup = null;
      room.completed += 1;
      room.message = `${player.name} nailed the double!${dbl ? " (2× DOUBLE!)" : ""}`;
      emitRoom(room);
      cb?.({ ok: true });
      return setTimeout(() => startResolveThenNext(room), 900);
    }

    // ── NORMAL / INVERTED / BOMB ──────────────────────────────────────────────
    const correct = room.currentRound.signalType === type;
    room.currentRound.signalOpen = false;

    if (correct) {
      const fastBonus = Math.max(0, Math.floor((room.currentRound.stageEndsAt - Date.now()) / 500));
      const dbl = player.heldPowerup === "DOUBLE";
      player.score += (1 + fastBonus) * (dbl ? 2 : 1);
      if (dbl) player.heldPowerup = null;
      room.completed += 1;
      const suffix = dbl ? " (2× DOUBLE!)" : "";
      if (modifier === "bomb")          room.message = `${player.name} defused it!${suffix}`;
      else if (modifier === "inverted") room.message = `${player.name} saw through the lie!${suffix}`;
      else                              room.message = `${player.name} got it!${suffix}`;
      emitRoom(room);
      cb?.({ ok: true });
      return setTimeout(() => startResolveThenNext(room), 900);
    }

    // Wrong reaction
    const shield = player.heldPowerup === "SHIELD";
    if (!shield) player.score = Math.max(0, player.score - cfg.penalty);
    if (shield)  player.heldPowerup = null;
    const shieldSuffix = shield ? " (Shield absorbed it!)" : "";
    if (modifier === "bomb")          room.message = `${player.name} hit the wrong wire! 💥${shieldSuffix}`;
    else if (modifier === "inverted") room.message = `${player.name} fell for the trick!${shieldSuffix}`;
    else                              room.message = `${player.name} messed up.${shieldSuffix}`;
    emitRoom(room);
    cb?.({ ok: false, shielded: shield });
    return setTimeout(() => startResolveThenNext(room), 900);
  });

  socket.on("disconnect", () => {
    for (const [code, room] of rooms.entries()) {
      const idx = room.players.findIndex(p => p.id === socket.id);
      if (idx === -1) continue;
      const wasHost = room.hostId === socket.id;
      room.players.splice(idx, 1);
      if (room.players.length === 0) { rooms.delete(code); continue; }
      if (wasHost) room.hostId = room.players[0].id;
      emitRoom(room);
    }
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => console.log(`Signal Break running on ${PORT}`));

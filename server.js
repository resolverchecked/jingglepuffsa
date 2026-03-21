const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static("public"));

const rooms = new Map();

const VALID_DIFFS = ["easy", "normal", "hard", "impossible"];
const VALID_MODES = ["duel", "team", "ffa", "escape"];

const GO_COLORS = ["RED", "ORANGE", "YELLOW", "WHITE"];
const FAKE_COLORS = ["BLUE", "GREEN", "PURPLE", "CYAN"];
const SHAPES = ["▲", "●", "■", "◆", "★", "⬟", "⬡", "⬢"];

const GO_WORDS = ["ARC","NEXUS","DELTA","SIGMA","ALPHA","BLAZE","PRISM","PULSE","GHOST","ORBIT","SLASH","SPARK","FLINT","CRUSH","SWIFT"];
const FAKE_WORDS = ["ECHO","NEON","FLUX","VOID","WIRE","NODE","LOCK","NOVA","ZERO","VORTEX","MIRROR","STATIC","VECTOR","CIPHER","FREEZE"];

const POWERUP_TYPES = ["SHIELD", "DOUBLE", "BOOST", "REVEAL"];
const POWERUP_SPAWN_CHANCE = 0.45;

const ESCAPE_WORDS = [
  "MAGNOLIA", "STARFALL", "BLACKOUT", "NIGHTFOG", "OVERRIDE",
  "SILENTLY", "WILDFIRE", "CRYSTALS", "HORIZONS", "MOONRISE"
];

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 5; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function rand(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function normToken(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function caesar(str, shift) {
  const n = ((shift % 26) + 26) % 26;
  return [...String(str).toUpperCase()].map(ch => {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) return ch;
    return String.fromCharCode(65 + ((c - 65 + n) % 26));
  }).join("");
}

function reverseStr(str) {
  return [...String(str)].reverse().join("");
}

function atbash(str) {
  return [...String(str).toUpperCase()].map(ch => {
    const c = ch.charCodeAt(0);
    if (c < 65 || c > 90) return ch;
    return String.fromCharCode(90 - (c - 65));
  }).join("");
}

function oddPositions(str) {
  return [...String(str)].filter((_, i) => i % 2 === 0).join("");
}

function rotateLeft(str, n) {
  const s = String(str);
  if (!s.length) return s;
  const k = ((n % s.length) + s.length) % s.length;
  return s.slice(k) + s.slice(0, k);
}

function stripVowels(str) {
  return String(str).replace(/[AEIOU]/gi, "");
}

function maxPlayersForMode(mode) {
  if (mode === "duel") return 2;
  if (mode === "team") return 4;
  if (mode === "escape") return 10;
  return 10;
}

function minPlayersForMode(mode) {
  if (mode === "duel") return 2;
  if (mode === "team") return 4;
  return 1;
}

function baseHpForDifficulty(diff) {
  if (diff === "easy") return 8;
  if (diff === "normal") return 7;
  if (diff === "hard") return 6;
  return 5;
}

function difficultyFor(room) {
  const round = Math.max(1, room.round || 1);
  const modeBoost = room.mode === "team" ? 1.18 : room.mode === "ffa" ? 1.08 : 1.0;
  const roundFactor = Math.max(0.82, 1 - (round - 1) * 0.02) * modeBoost;
  const fakeBoost = Math.min(0.22, (round - 1) * 0.012);

  if (room.difficulty === "easy") {
    return {
      prep: Math.round(8500 * roundFactor),
      signal: Math.round(4800 * roundFactor),
      fakeChance: Math.min(0.50, 0.22 + fakeBoost),
    };
  }
  if (room.difficulty === "hard") {
    return {
      prep: Math.max(3800, Math.round(6500 * roundFactor)),
      signal: Math.max(2200, Math.round(3500 * roundFactor)),
      fakeChance: Math.min(0.70, 0.45 + fakeBoost),
    };
  }
  if (room.difficulty === "impossible") {
    return {
      prep: Math.max(3000, Math.round(5500 * roundFactor)),
      signal: Math.max(1800, Math.round(2900 * roundFactor)),
      fakeChance: Math.min(0.88, 0.60 + fakeBoost * 1.5),
    };
  }
  return {
    prep: Math.max(4200, Math.round(7600 * roundFactor)),
    signal: Math.max(2400, Math.round(4200 * roundFactor)),
    fakeChance: Math.min(0.60, 0.33 + fakeBoost),
  };
}

function getRoundModifier(room) {
  const round = room.round || 1;
  const diff = room.difficulty;
  const rScale = Math.min(0.16, (round - 1) * 0.01);

  const bombC = ({ easy: 0.05, normal: 0.10, hard: 0.16, impossible: 0.22 }[diff] ?? 0.10) + rScale;
  const invertC = ({ easy: 0.10, normal: 0.18, hard: 0.26, impossible: 0.34 }[diff] ?? 0.18) + rScale;
  const doubleC = ({ easy: 0.08, normal: 0.11, hard: 0.14, impossible: 0.18 }[diff] ?? 0.11) + rScale * 0.5;

  const r = Math.random();
  if (r < bombC) return "bomb";
  if (r < bombC + invertC) return "inverted";
  if (r < bombC + invertC + doubleC) return "doublehit";
  return "normal";
}

function buildClues(realType, modifier) {
  if (modifier === "bomb") {
    return { clueA: "ORANGE ✚", clueB: "ZERO", lock: "!!!" };
  }
  const isGo = realType === "go";
  const colour = rand(isGo ? GO_COLORS : FAKE_COLORS);
  const clueA = `${colour} ${rand(SHAPES)}`;
  const clueB = rand(isGo ? GO_WORDS : FAKE_WORDS);
  let lockNum;
  do {
    lockNum = Math.floor(100 + Math.random() * 900);
  } while ((lockNum % 2 === 0) !== (!isGo));
  return { clueA, clueB, lock: String(lockNum) };
}

function maybeSpawnPowerup() {
  if (Math.random() > POWERUP_SPAWN_CHANCE) return null;
  return { type: rand(POWERUP_TYPES), claimedBy: null, claimedByName: null };
}

function escapeTimeMs(diff) {
  if (diff === "easy") return 80000;
  if (diff === "normal") return 65000;
  if (diff === "hard") return 50000;
  return 40000;
}

function makeEscapePuzzle(room) {
  const baseWord = rand(ESCAPE_WORDS);
  const shift = 3 + Math.floor(Math.random() * 7);
  const checksum = String((shift + room.round + baseWord.length) % 10);

  const stack = [];
  let answer = baseWord;
  let cipher = caesar(baseWord, shift);

  if (room.difficulty === "easy") {
    stack.push({
      name: "CAESAR",
      detail: `Shift the cipher BACK by ${shift}.`,
      example: `Cipher: ${cipher}`,
      method: `Subtract ${shift}`,
    });
    answer = baseWord;
  } else if (room.difficulty === "normal") {
    stack.push({
      name: "CAESAR",
      detail: `Shift the cipher BACK by ${shift}.`,
      example: `Cipher: ${cipher}`,
      method: `Subtract ${shift}`,
    });
    stack.push({
      name: "MIRROR",
      detail: "Reverse the decoded word.",
      example: "Left becomes right.",
      method: "Reverse",
    });
    answer = reverseStr(baseWord);
  } else if (room.difficulty === "hard") {
    stack.push({
      name: "CAESAR",
      detail: `Shift the cipher BACK by ${shift}.`,
      example: `Cipher: ${cipher}`,
      method: `Subtract ${shift}`,
    });
    stack.push({
      name: "MIRROR",
      detail: "Reverse the decoded word.",
      example: "Left becomes right.",
      method: "Reverse",
    });
    stack.push({
      name: "FRACTURE",
      detail: "Keep only letters in odd positions.",
      example: "1st, 3rd, 5th, ...",
      method: "Odd positions",
    });
    answer = oddPositions(reverseStr(baseWord));
  } else {
    const vShift = 2 + Math.floor(Math.random() * 4);
    cipher = caesar(rotateLeft(baseWord, vShift), shift);
    stack.push({
      name: "CAESAR",
      detail: `Shift the cipher BACK by ${shift}.`,
      example: `Cipher: ${cipher}`,
      method: `Subtract ${shift}`,
    });
    stack.push({
      name: "MIRROR",
      detail: "Reverse the decoded word.",
      example: "Left becomes right.",
      method: "Reverse",
    });
    stack.push({
      name: "FRACTURE",
      detail: "Keep only letters in odd positions.",
      example: "1st, 3rd, 5th, ...",
      method: "Odd positions",
    });
    stack.push({
      name: "BLACK GLASS",
      detail: "Apply Atbash to the remaining letters.",
      example: "A↔Z, B↔Y, C↔X...",
      method: "Atbash",
    });
    stack.push({
      name: "OFFSET",
      detail: `Rotate the result left by ${vShift}.`,
      example: `Shift the string ${vShift} spots left.`,
      method: `Rotate ${vShift}`,
    });
    stack.push({
      name: "CHECKSUM",
      detail: `Append the digit ${checksum} to the end.`,
      example: "Final digit matters.",
      method: `Append ${checksum}`,
    });
    answer = `${rotateLeft(atbash(oddPositions(reverseStr(baseWord))), vShift)}${checksum}`;
  }

  const pages = [];
  pages.push(`PAGE 1 — ENCODER INDEX\nThe first layer is always Caesar.\nUnwind the chain in order.`);
  stack.forEach((step, i) => {
    pages.push(`PAGE ${i + 2} — ${step.name}\n${step.detail}\n${step.example}`);
  });

  return {
    id: `${room.code}-${room.round}-${Date.now()}`,
    cipher,
    answer: normToken(answer),
    pages,
    stack,
    mechanicLabel: stack.map(s => s.name).join(" → "),
    description: `Unwind ${stack.length} encoder layer${stack.length === 1 ? "" : "s"} and submit the final code.`,
    timeMs: escapeTimeMs(room.difficulty),
    shift,
    checksum,
    baseWord,
    solveText: `Decoded stage ${room.round} cleared.`,
  };
}

function initializeStats(room) {
  const hp = baseHpForDifficulty(room.difficulty);
  if (room.mode === "team") {
    const teamHp = hp * 2;
    room.teams = [
      { id: "A", name: "Team A", score: 0, hp: teamHp, maxHp: teamHp },
      { id: "B", name: "Team B", score: 0, hp: teamHp, maxHp: teamHp },
    ];
    room.players.forEach((p, i) => {
      p.score = 0;
      p.hp = hp;
      p.maxHp = hp;
      p.heldPowerup = null;
      p.team = i % 2 === 0 ? "A" : "B";
    });
  } else {
    room.teams = null;
    room.players.forEach((p) => {
      p.score = 0;
      p.hp = hp;
      p.maxHp = hp;
      p.heldPowerup = null;
      p.team = null;
    });
  }
}

function addScore(room, player, points) {
  player.score += points;
  if (room.mode === "team" && room.teams && player.team) {
    const team = room.teams.find((t) => t.id === player.team);
    if (team) team.score += points;
  }
}

function damageEntity(room, player, amount) {
  if (room.mode === "team" && room.teams && player.team) {
    const team = room.teams.find((t) => t.id === player.team);
    if (team) team.hp = Math.max(0, team.hp - amount);
    return;
  }
  player.hp = Math.max(0, player.hp - amount);
}

function aliveTeams(room) {
  if (room.mode !== "team" || !room.teams) return [];
  return room.teams.filter((t) => t.hp > 0);
}

function alivePlayers(room) {
  return room.players.filter((p) => p.hp > 0);
}

function finalTitle(room) {
  if (room.mode === "escape") {
    return room.escape?.strikes >= 3 ? "Escape failed." : "Escape cleared.";
  }
  if (room.mode === "team" && room.teams) {
    const [a, b] = [...room.teams].sort((x, y) => y.score - x.score || y.hp - x.hp);
    if (a.score === b.score && a.hp === b.hp) return "Draw.";
    return `${a.name} wins.`;
  }
  const sorted = [...room.players].sort((a, b) => b.score - a.score || b.hp - a.hp);
  if (!sorted.length) return "Draw.";
  const top = sorted[0];
  const tied = sorted.filter((p) => p.score === top.score && p.hp === top.hp);
  if (tied.length > 1) return "Draw.";
  return `${top.name} wins.`;
}

function shouldEnd(room) {
  if (room.mode === "escape") return room.escape?.strikes >= 3 || room.round > room.totalRounds;
  if (room.round > room.totalRounds) return true;
  if (room.mode === "team") return aliveTeams(room).length <= 1;
  return alivePlayers(room).length <= 1;
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    mode: room.mode,
    round: room.round,
    totalRounds: room.totalRounds,
    difficulty: room.difficulty,
    message: room.message,
    teams: room.teams,

    escape: room.mode === "escape" ? {
      strikes: room.escape?.strikes ?? 0,
      solved: room.escape?.solved ?? 0,
      total: room.escape?.total ?? room.totalRounds,
      currentPuzzle: room.currentPuzzle ? {
        cipher: room.currentPuzzle.cipher,
        pages: room.currentPuzzle.pages,
        stack: room.currentPuzzle.stack,
        mechanicLabel: room.currentPuzzle.mechanicLabel,
        description: room.currentPuzzle.description,
        timeEndsAt: room.currentPuzzle.timeEndsAt,
        timeMs: room.currentPuzzle.timeMs,
      } : null,
    } : null,

    clueA: room.currentRound?.clueA ?? null,
    clueB: room.currentRound?.clueB ?? null,
    lock: room.currentRound?.lock ?? null,
    roundModifier: room.currentRound?.roundModifier ?? "normal",
    realSignal: room.currentRound?.realSignal ?? null,
    signalType: room.currentRound?.signalType ?? null,
    signalOpen: room.currentRound?.signalOpen ?? false,
    stageEndsAt: room.mode === "escape" ? room.currentPuzzle?.timeEndsAt ?? null : room.currentRound?.stageEndsAt ?? null,
    stageTotalMs: room.mode === "escape" ? room.currentPuzzle?.timeMs ?? null : room.currentRound?.stageTotalMs ?? null,
    doubleHit: room.currentRound?.doubleHit ?? 0,
    roundPowerup: room.currentRound?.roundPowerup ?? null,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      hp: p.hp,
      maxHp: p.maxHp,
      team: p.team,
      heldPowerup: p.heldPowerup ?? null,
    })),
  };
}

function emitRoom(room) {
  io.to(room.code).emit("roomState", publicRoom(room));
}

function finishGame(room, message) {
  room.phase = "ended";
  room.message = message || finalTitle(room);
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

    if (fresh.mode === "escape") {
      if (fresh.escape?.strikes >= 3) return finishGame(fresh, "Escape failed.");
      if (fresh.round >= fresh.totalRounds) return finishGame(fresh, "Escape cleared.");
      fresh.round += 1;
      startEscapePuzzle(fresh);
      return;
    }

    if (shouldEnd(fresh)) {
      finishGame(fresh, finalTitle(fresh));
      return;
    }

    if (fresh.round >= fresh.totalRounds) {
      finishGame(fresh, finalTitle(fresh));
      return;
    }

    fresh.round += 1;
    startPrep(fresh);
  }, 1200);
}

function startSignal(room) {
  const cfg = difficultyFor(room);
  const modifier = room.currentRound.roundModifier;
  const boostMs = room.currentRound.boostApplied ? 900 : 0;
  const sigMs = cfg.signal + boostMs;

  room.phase = "signal";
  room.currentRound.signalOpen = true;
  room.currentRound.stageEndsAt = Date.now() + sigMs;
  room.currentRound.stageTotalMs = sigMs;

  if (modifier === "bomb") {
    room.currentRound.signalType = "bomb";
    room.message = "💣 DEFUSE IT!";
  } else if (modifier === "inverted") {
    const real = room.currentRound.realSignal;
    room.currentRound.signalType = real;
    room.message = real === "go" ? "FAKE SIGNAL!" : "GO!";
  } else if (modifier === "doublehit") {
    room.currentRound.signalType = "go";
    room.currentRound.doubleHit = 0;
    room.message = "HIT TWICE! GO GO!";
  } else {
    room.message = room.currentRound.signalType === "go" ? "GO!" : "FAKE SIGNAL!";
  }

  emitRoom(room);

  setTimeout(() => {
    const fresh = rooms.get(room.code);
    if (!fresh || fresh.phase !== "signal" || !fresh.currentRound || !fresh.currentRound.signalOpen) return;

    fresh.currentRound.signalOpen = false;
    const mod = fresh.currentRound.roundModifier;
    const st = fresh.currentRound.signalType;

    if (mod === "bomb") fresh.message = "💥 Bomb exploded.";
    else if (mod === "doublehit") {
      if ((fresh.currentRound.doubleHit || 0) < 2) fresh.message = "Too slow — needed two hits.";
      else fresh.message = "Chain completed.";
    } else if (st === "go") {
      fresh.message = "Too slow.";
    } else {
      fresh.message = "Fake signal — held steady.";
    }

    startResolveThenNext(fresh);
  }, sigMs);
}

function startPrep(room) {
  const cfg = difficultyFor(room);
  const modifier = getRoundModifier(room);

  let realSignal, signalType;
  if (modifier === "bomb") {
    realSignal = "bomb";
    signalType = "bomb";
  } else {
    const isGo = Math.random() >= cfg.fakeChance;
    realSignal = isGo ? "go" : "fake";
    signalType = isGo ? "go" : "fake";
  }

  const clues = buildClues(realSignal, modifier);

  room.currentRound = {
    ...clues,
    roundModifier: modifier,
    roundPowerup: maybeSpawnPowerup(),
    signalOpen: false,
    stageEndsAt: Date.now() + cfg.prep,
    stageTotalMs: cfg.prep,
    doubleHit: 0,
    boostApplied: false,
    realSignal,
    signalType,
  };

  room.phase = "prep";
  room.message = "Study the clues.";
  emitRoom(room);

  setTimeout(() => {
    const fresh = rooms.get(room.code);
    if (!fresh || fresh.phase === "ended") return;
    if (fresh.currentRound?.stageEndsAt && Date.now() >= fresh.currentRound.stageEndsAt - 5) {
      startSignal(fresh);
    }
  }, cfg.prep);
}

function startEscapePuzzle(room) {
  const puzzle = makeEscapePuzzle(room);
  room.currentPuzzle = {
    ...puzzle,
    timeEndsAt: Date.now() + puzzle.timeMs,
  };
  room.phase = "escape";
  room.message = puzzle.description;
  emitRoom(room);

  const puzzleId = puzzle.id;

  setTimeout(() => {
    const fresh = rooms.get(room.code);
    if (!fresh || fresh.phase !== "escape" || fresh.currentPuzzle?.id !== puzzleId) return;

    fresh.escape.strikes += 1;
    fresh.message = `Time expired. Strike ${fresh.escape.strikes}/3.`;

    if (fresh.escape.strikes >= 3) {
      finishGame(fresh, "Escape failed.");
      return;
    }

    fresh.round += 1;
    if (fresh.round > fresh.totalRounds) {
      finishGame(fresh, "Escape cleared.");
      return;
    }

    startEscapePuzzle(fresh);
  }, puzzle.timeMs);
}

io.on("connection", socket => {
  socket.on("createRoom", ({ name, difficulty, totalRounds, mode }, cb) => {
    const diff = VALID_DIFFS.includes(difficulty) ? difficulty : "normal";
    const gameMode = VALID_MODES.includes(mode) ? mode : "ffa";
    const code = makeCode();

    const room = {
      code,
      hostId: socket.id,
      phase: "lobby",
      mode: gameMode,
      round: 1,
      totalRounds: Math.max(1, Math.min(25, Number(totalRounds) || 8)),
      difficulty: diff,
      players: [{
        id: socket.id,
        name: String(name || "Host").slice(0, 20),
        score: 0,
        hp: baseHpForDifficulty(diff),
        maxHp: baseHpForDifficulty(diff),
        heldPowerup: null,
        team: gameMode === "team" ? "A" : null,
      }],
      teams: null,
      currentRound: null,
      currentPuzzle: null,
      escape: gameMode === "escape" ? { strikes: 0, solved: 0, total: Math.max(1, Math.min(25, Number(totalRounds) || 8)) } : null,
      message: "Room created.",
    };

    if (gameMode === "team") {
      room.teams = [
        { id: "A", name: "Team A", score: 0, hp: baseHpForDifficulty(diff) * 2, maxHp: baseHpForDifficulty(diff) * 2 },
        { id: "B", name: "Team B", score: 0, hp: baseHpForDifficulty(diff) * 2, maxHp: baseHpForDifficulty(diff) * 2 },
      ];
    }

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
    if (room.players.length >= maxPlayersForMode(room.mode)) return cb?.({ ok: false, error: "Room is full." });

    const teamPick = room.mode === "team"
      ? (room.players.filter((p) => p.team === "A").length <= room.players.filter((p) => p.team === "B").length ? "A" : "B")
      : null;

    room.players.push({
      id: socket.id,
      name: String(name || `Player ${room.players.length + 1}`).slice(0, 20),
      score: 0,
      hp: baseHpForDifficulty(room.difficulty),
      maxHp: baseHpForDifficulty(room.difficulty),
      heldPowerup: null,
      team: teamPick,
    });

    if (room.mode === "team" && room.teams) {
      room.teams = [
        {
          id: "A",
          name: "Team A",
          score: 0,
          hp: room.players.filter((p) => p.team === "A").length * baseHpForDifficulty(room.difficulty),
          maxHp: room.players.filter((p) => p.team === "A").length * baseHpForDifficulty(room.difficulty),
        },
        {
          id: "B",
          name: "Team B",
          score: 0,
          hp: room.players.filter((p) => p.team === "B").length * baseHpForDifficulty(room.difficulty),
          maxHp: room.players.filter((p) => p.team === "B").length * baseHpForDifficulty(room.difficulty),
        },
      ];
    }

    socket.join(code);
    cb?.({ ok: true, state: publicRoom(room) });
    emitRoom(room);
  });

  socket.on("startGame", ({ code }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb?.({ ok: false, error: "Room not found." });
    if (room.hostId !== socket.id) return cb?.({ ok: false, error: "Only the host can start." });
    if (room.players.length < minPlayersForMode(room.mode)) {
      return cb?.({ ok: false, error: `Need at least ${minPlayersForMode(room.mode)} player(s).` });
    }

    room.phase = "starting";
    room.message = "Starting...";
    emitRoom(room);

    setTimeout(() => {
      const fresh = rooms.get(code);
      if (!fresh) return;

      fresh.round = 1;
      fresh.completed = 0;
      fresh.message = "Starting...";

      fresh.players.forEach(p => {
        p.score = 0;
        p.heldPowerup = null;
        if (fresh.mode === "escape") {
          p.hp = 0;
          p.maxHp = 0;
          p.team = null;
        }
      });

      if (fresh.mode === "escape") {
        fresh.escape = { strikes: 0, solved: 0, total: fresh.totalRounds };
        startEscapePuzzle(fresh);
        cb?.({ ok: true });
        return;
      }

      initializeStats(fresh);
      fresh.objective = difficultyFor({ difficulty: fresh.difficulty, round: 1 }).objective;
      startPrep(fresh);
      cb?.({ ok: true });
    }, 700);
  });

  socket.on("claimPowerup", ({ code }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room || room.mode === "escape") return cb?.({ ok: false, error: "No powerups in this mode." });
    if (!room || room.phase !== "prep" || !room.currentRound?.roundPowerup) {
      return cb?.({ ok: false, error: "No powerup available." });
    }

    const pu = room.currentRound.roundPowerup;
    if (pu.claimedBy) return cb?.({ ok: false, error: "Already claimed." });

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return cb?.({ ok: false, error: "Not in room." });
    if (player.heldPowerup) return cb?.({ ok: false, error: "You already hold a powerup." });

    pu.claimedBy = socket.id;
    pu.claimedByName = player.name;

    if (pu.type === "BOOST") {
      room.currentRound.boostApplied = true;
      room.message = `${player.name} activated BOOST — longer signal window!`;
      emitRoom(room);
      cb?.({ ok: true, type: pu.type });
      return;
    }

    if (pu.type === "REVEAL") {
      socket.emit("powerupReveal", { realSignal: room.currentRound.realSignal });
      room.message = `${player.name} used REVEAL.`;
      emitRoom(room);
      cb?.({ ok: true, type: pu.type, consumed: true });
      return;
    }

    player.heldPowerup = pu.type;
    room.message = `${player.name} grabbed ${pu.type}!`;
    emitRoom(room);
    cb?.({ ok: true, type: pu.type });
  });

  socket.on("reaction", ({ code, type }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);
    if (!room || room.mode === "escape") return cb?.({ ok: false, error: "Use the escape puzzle submit box." });
    if (!room || room.phase !== "signal" || !room.currentRound?.signalOpen) {
      return cb?.({ ok: false, error: "No active signal." });
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return cb?.({ ok: false, error: "Not in room." });

    const modifier = room.currentRound.roundModifier;
    const target = room.currentRound.signalType;
    const cfg = difficultyFor(room);
    const damage = Math.max(1, (room.difficulty === "easy" ? 1 : room.difficulty === "normal" ? 1 : 2) + Math.floor((room.round - 1) / 2));
    const fastBonus = Math.max(0, Math.floor((room.currentRound.stageEndsAt - Date.now()) / 650));

    if (modifier === "doublehit") {
      if (type !== "go") {
        room.currentRound.signalOpen = false;
        const shield = player.heldPowerup === "SHIELD";
        if (!shield) damageEntity(room, player, damage);
        if (shield) player.heldPowerup = null;
        room.message = `${player.name} pressed wrong!${shield ? " (Shield absorbed it)" : ""}`;
        emitRoom(room);
        cb?.({ ok: false, shielded: shield });
        return setTimeout(() => startResolveThenNext(room), 900);
      }

      room.currentRound.doubleHit = (room.currentRound.doubleHit || 0) + 1;
      const points = 1 + fastBonus;
      const dbl = player.heldPowerup === "DOUBLE";
      addScore(room, player, points * (dbl ? 2 : 1));
      if (dbl) player.heldPowerup = null;
      emitRoom(room);

      if (room.currentRound.doubleHit < 2) {
        room.message = "ONE MORE!";
        emitRoom(room);
        cb?.({ ok: true, partial: true });
        return;
      }

      room.currentRound.signalOpen = false;
      room.message = `${player.name} completed the chain!${dbl ? " (2× DOUBLE!)" : ""}`;
      emitRoom(room);
      cb?.({ ok: true });
      return setTimeout(() => startResolveThenNext(room), 900);
    }

    const correct = target === type;
    room.currentRound.signalOpen = false;

    if (correct) {
      const dbl = player.heldPowerup === "DOUBLE";
      addScore(room, player, (1 + fastBonus) * (dbl ? 2 : 1));
      if (dbl) player.heldPowerup = null;

      if (modifier === "bomb") room.message = `${player.name} defused it!${dbl ? " (2× DOUBLE!)" : ""}`;
      else if (modifier === "inverted") room.message = `${player.name} saw through the lie!${dbl ? " (2× DOUBLE!)" : ""}`;
      else room.message = `${player.name} got it!${dbl ? " (2× DOUBLE!)" : ""}`;

      emitRoom(room);
      cb?.({ ok: true });
      return setTimeout(() => startResolveThenNext(room), 900);
    }

    const shield = player.heldPowerup === "SHIELD";
    if (!shield) damageEntity(room, player, damage);
    if (shield) player.heldPowerup = null;

    if (modifier === "bomb") room.message = `${player.name} hit the wrong wire! 💥${shield ? " (Shield absorbed it!)" : ""}`;
    else if (modifier === "inverted") room.message = `${player.name} fell for the trick!${shield ? " (Shield absorbed it!)" : ""}`;
    else room.message = `${player.name} messed up.${shield ? " (Shield absorbed it!)" : ""}`;

    emitRoom(room);
    cb?.({ ok: false, shielded: shield });
    return setTimeout(() => startResolveThenNext(room), 900);
  });

  socket.on("escapeSubmit", ({ code, answer }, cb) => {
    code = String(code || "").toUpperCase().trim();
    const room = rooms.get(code);

    if (!room || room.mode !== "escape" || room.phase !== "escape" || !room.currentPuzzle) {
      return cb?.({ ok: false, error: "No active escape puzzle." });
    }

    const player = room.players.find((p) => p.id === socket.id);
    if (!player) return cb?.({ ok: false, error: "Not in room." });

    const submitted = normToken(answer);
    const target = room.currentPuzzle.answer;

    if (submitted !== target) {
      room.escape.strikes += 1;
      room.message = `Wrong decode. Strike ${room.escape.strikes}/3.`;
      emitRoom(room);

      if (room.escape.strikes >= 3) {
        finishGame(room, "Escape failed.");
      }

      cb?.({ ok: false, strikes: room.escape.strikes });
      return;
    }

    const bonus = Math.max(1, Math.floor((room.currentPuzzle.timeEndsAt - Date.now()) / 800));
    player.score += 2 + bonus;
    room.escape.solved += 1;
    room.message = room.currentPuzzle.solveText || `Decoded stage ${room.round} cleared.`;
    emitRoom(room);

    cb?.({ ok: true, bonus });

    setTimeout(() => {
      const fresh = rooms.get(code);
      if (!fresh || fresh.mode !== "escape" || fresh.phase !== "escape") return;

      if (fresh.escape.strikes >= 3) {
        finishGame(fresh, "Escape failed.");
        return;
      }

      if (fresh.round >= fresh.totalRounds) {
        finishGame(fresh, "Escape cleared.");
        return;
      }

      fresh.round += 1;
      startEscapePuzzle(fresh);
    }, 850);
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

      if (room.mode === "team" && room.teams) {
        room.teams = [
          {
            id: "A",
            name: "Team A",
            score: 0,
            hp: room.players.filter((p) => p.team === "A").length * baseHpForDifficulty(room.difficulty),
            maxHp: room.players.filter((p) => p.team === "A").length * baseHpForDifficulty(room.difficulty),
          },
          {
            id: "B",
            name: "Team B",
            score: 0,
            hp: room.players.filter((p) => p.team === "B").length * baseHpForDifficulty(room.difficulty),
            maxHp: room.players.filter((p) => p.team === "B").length * baseHpForDifficulty(room.difficulty),
          },
        ];
      }

      emitRoom(room);
    }
  });
});

app.get("/", (_, res) => res.send("Signal Break server running."));

const PORT = process.env.PORT || 5000;
server.listen(PORT, "0.0.0.0", () => console.log(`Signal Break running on ${PORT}`));

require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Load puzzles from environment variables
// Format: PUZZLE_001=ANSWER|Clue text here
// ---------------------------------------------------------------------------
function loadPuzzles() {
  const puzzles = [];
  const keys = Object.keys(process.env)
    .filter(k => /^PUZZLE_\d+$/.test(k))
    .sort();

  for (const key of keys) {
    const id = key.replace('PUZZLE_', '');
    const value = process.env[key];
    const pipeIndex = value.indexOf('|');
    if (pipeIndex === -1) {
      console.warn(`Skipping ${key}: missing pipe delimiter`);
      continue;
    }
    const answer = value.substring(0, pipeIndex).toUpperCase().trim();
    const clue = value.substring(pipeIndex + 1).trim();

    if (answer.length !== 5) {
      console.warn(`Skipping ${key}: answer "${answer}" is not 5 characters`);
      continue;
    }
    if (!/^[A-Z0-9\-]+$/.test(answer)) {
      console.warn(`Skipping ${key}: answer contains invalid characters`);
      continue;
    }

    puzzles.push({ id, answer, clue });
  }

  console.log(`Loaded ${puzzles.length} puzzles`);
  return puzzles;
}

const PUZZLES = loadPuzzles();
const START_DATE = process.env.START_DATE || '2026-02-01';

// ---------------------------------------------------------------------------
// Eastern‑time helpers (respects DST via Intl)
// ---------------------------------------------------------------------------
function getEasternNow() {
  const now = new Date();
  const eastern = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/New_York' })
  );
  return eastern;
}

function getEasternDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

function getNextMidnightEasternUTC() {
  const now = new Date();
  const easternNow = new Date(
    now.toLocaleString('en-US', { timeZone: 'America/New_York' })
  );
  const utcNow = new Date(
    now.toLocaleString('en-US', { timeZone: 'UTC' })
  );
  const offsetMs = utcNow.getTime() - easternNow.getTime();

  const nextMidnight = new Date(easternNow);
  nextMidnight.setHours(24, 0, 0, 0);

  return new Date(nextMidnight.getTime() + offsetMs);
}

function dateDiffDays(dateStrA, dateStrB) {
  const a = new Date(dateStrA + 'T00:00:00');
  const b = new Date(dateStrB + 'T00:00:00');
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

function getCurrentPuzzleNumber() {
  const today = getEasternDateString();
  const diff = dateDiffDays(START_DATE, today);
  return Math.max(0, diff);
}

function getPuzzleDateString(puzzleIndex) {
  const start = new Date(START_DATE + 'T00:00:00');
  start.setDate(start.getDate() + puzzleIndex);
  return start.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Wordle guess‑checking algorithm
// ---------------------------------------------------------------------------
function checkGuess(guess, answer) {
  const result = new Array(5);
  const answerArr = answer.split('');
  const guessArr = guess.split('');
  const remaining = [...answerArr];

  // Pass 1: mark correct (green)
  for (let i = 0; i < 5; i++) {
    if (guessArr[i] === answerArr[i]) {
      result[i] = { letter: guessArr[i], status: 'correct' };
      remaining[i] = null;
    }
  }

  // Pass 2: mark present (yellow) or absent (gray)
  for (let i = 0; i < 5; i++) {
    if (result[i]) continue;
    const idx = remaining.indexOf(guessArr[i]);
    if (idx !== -1) {
      result[i] = { letter: guessArr[i], status: 'present' };
      remaining[idx] = null;
    } else {
      result[i] = { letter: guessArr[i], status: 'absent' };
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------

// GET /api/today – current puzzle info (no answer)
app.get('/api/today', (req, res) => {
  const puzzleIndex = getCurrentPuzzleNumber();
  const totalAvailable = Math.min(puzzleIndex + 1, PUZZLES.length);

  if (puzzleIndex < 0 || PUZZLES.length === 0) {
    return res.json({
      active: false,
      message: 'No puzzles available yet. Check back soon!',
      nextPuzzleTime: getNextMidnightEasternUTC().toISOString(),
      totalAvailable: 0,
      totalPuzzles: PUZZLES.length
    });
  }

  const currentIndex = Math.min(puzzleIndex, PUZZLES.length - 1);
  const puzzle = PUZZLES[currentIndex];
  const allSolved = puzzleIndex >= PUZZLES.length;

  res.json({
    active: !allSolved,
    puzzleNumber: currentIndex + 1,
    puzzleId: puzzle.id,
    clue: puzzle.clue,
    date: getPuzzleDateString(currentIndex),
    totalAvailable,
    totalPuzzles: PUZZLES.length,
    nextPuzzleTime: getNextMidnightEasternUTC().toISOString(),
    allSolved
  });
});

// GET /api/puzzle/:puzzleNumber – specific puzzle info (1‑indexed)
app.get('/api/puzzle/:puzzleNumber', (req, res) => {
  const num = parseInt(req.params.puzzleNumber, 10);
  if (isNaN(num) || num < 1 || num > PUZZLES.length) {
    return res.status(404).json({ error: 'Puzzle not found' });
  }

  const maxAvailable = getCurrentPuzzleNumber() + 1;
  if (num > maxAvailable) {
    return res.status(403).json({ error: 'This puzzle is not available yet' });
  }

  const puzzle = PUZZLES[num - 1];
  res.json({
    puzzleNumber: num,
    puzzleId: puzzle.id,
    clue: puzzle.clue,
    date: getPuzzleDateString(num - 1)
  });
});

// POST /api/guess – validate a guess
app.post('/api/guess', (req, res) => {
  const { puzzleId, guess } = req.body;

  if (!puzzleId || !guess) {
    return res.status(400).json({ error: 'Missing puzzleId or guess' });
  }

  const upperGuess = guess.toUpperCase().trim();
  if (upperGuess.length !== 5 || !/^[A-Z0-9\-]+$/.test(upperGuess)) {
    return res.status(400).json({ error: 'Guess must be 5 characters (A-Z, 0-9, -)' });
  }

  const puzzle = PUZZLES.find(p => p.id === puzzleId);
  if (!puzzle) {
    return res.status(404).json({ error: 'Puzzle not found' });
  }

  // Verify this puzzle is actually available
  const puzzleIndex = PUZZLES.indexOf(puzzle);
  const maxAvailable = getCurrentPuzzleNumber() + 1;
  if (puzzleIndex + 1 > maxAvailable) {
    return res.status(403).json({ error: 'This puzzle is not available yet' });
  }

  const result = checkGuess(upperGuess, puzzle.answer);
  const correct = upperGuess === puzzle.answer;

  res.json({ result, correct });
});

// GET /api/puzzles/list – all available puzzles (no answers)
app.get('/api/puzzles/list', (req, res) => {
  const maxAvailable = Math.min(getCurrentPuzzleNumber() + 1, PUZZLES.length);
  const list = PUZZLES.slice(0, maxAvailable).map((p, i) => ({
    puzzleNumber: i + 1,
    puzzleId: p.id,
    clue: p.clue,
    date: getPuzzleDateString(i)
  }));

  res.json({
    puzzles: list,
    totalPuzzles: PUZZLES.length,
    nextPuzzleTime: getNextMidnightEasternUTC().toISOString()
  });
});

// GET /api/reveal/:puzzleId – reveal the answer (only if user has used all 6 guesses)
app.post('/api/reveal', (req, res) => {
  const { puzzleId } = req.body;
  const puzzle = PUZZLES.find(p => p.id === puzzleId);
  if (!puzzle) {
    return res.status(404).json({ error: 'Puzzle not found' });
  }
  // Trust is on the client here; server reveals answer on request
  // since there's no auth to track guess count server-side
  res.json({ answer: puzzle.answer });
});

// Fallback: serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`Slave, Vader, Wampa, Bingo running on port ${PORT}`);
  console.log(`Start date: ${START_DATE}`);
  console.log(`Current Eastern date: ${getEasternDateString()}`);
  console.log(`Current puzzle number: ${getCurrentPuzzleNumber() + 1}`);
  console.log(`Next puzzle at: ${getNextMidnightEasternUTC().toISOString()}`);
});
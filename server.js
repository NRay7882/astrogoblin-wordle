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
  const puzzleMap = {}; // date string 'YYYY-MM-DD' -> { id, answer, clue, date }
  const keys = Object.keys(process.env)
    .filter(k => /^PUZZLE_\d{8}$/.test(k))
    .sort();

  for (const key of keys) {
    const dateRaw = key.replace('PUZZLE_', '');
    const dateStr = `${dateRaw.slice(0,4)}-${dateRaw.slice(4,6)}-${dateRaw.slice(6,8)}`;
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

    puzzleMap[dateStr] = { id: dateRaw, answer, clue, date: dateStr };
  }

  console.log(`Loaded ${Object.keys(puzzleMap).length} puzzles`);
  return puzzleMap;
}

// Get sorted array of available puzzle dates up to today (Eastern)
function getAvailablePuzzleDates() {
  const today = getEasternDateString();
  return Object.keys(PUZZLES)
    .filter(d => d <= today)
    .sort();
}

// Get puzzle number (1-indexed) for a given date
function getPuzzleNumberForDate(dateStr) {
  const allDates = Object.keys(PUZZLES).sort();
  return allDates.indexOf(dateStr) + 1;
}

// Get total number of puzzles defined
function getTotalPuzzleCount() {
  return Object.keys(PUZZLES).length;
}

const PUZZLES = loadPuzzles();

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
  // Get the current time expressed in Eastern
  const now = new Date();
  const easternStr = now.toLocaleString('en-US', { timeZone: 'America/New_York' });
  const easternNow = new Date(easternStr);

  // Build next midnight in Eastern
  const nextMidnightEastern = new Date(easternNow);
  nextMidnightEastern.setHours(24, 0, 0, 0);

  // Difference in ms between real now and eastern now gives us the offset
  const offsetMs = now.getTime() - easternNow.getTime();

  // Apply the offset to get next midnight in real UTC
  return new Date(nextMidnightEastern.getTime() + offsetMs);
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
  const today = getEasternDateString();
  const available = getAvailablePuzzleDates();

  if (available.length === 0) {
    return res.json({
      active: false,
      message: 'No puzzles available yet. Check back soon!',
      nextPuzzleTime: getNextMidnightEasternUTC().toISOString(),
      totalAvailable: 0,
      totalPuzzles: getTotalPuzzleCount()
    });
  }

  const todayDate = available.includes(today) ? today : available[available.length - 1];
  const puzzle = PUZZLES[todayDate];

  // Check for future puzzles for next day
  const allDates = Object.keys(PUZZLES).sort();
  const lastPuzzleDate = allDates[allDates.length - 1];
  const hasMorePuzzles = today < lastPuzzleDate;

  res.json({
    active: true,
    puzzleNumber: getPuzzleNumberForDate(todayDate),
    puzzleId: puzzle.id,
    clue: puzzle.clue,
    date: puzzle.date,
    totalAvailable: available.length,
    totalPuzzles: getTotalPuzzleCount(),
    nextPuzzleTime: hasMorePuzzles ? getNextMidnightEasternUTC().toISOString() : null,
    hasMorePuzzles
  });
});

// GET /api/puzzle/:puzzleId – specific puzzle info by date-based id (YYYYMMDD)
app.get('/api/puzzle/:puzzleId', (req, res) => {
  const id = req.params.puzzleId;
  const puzzle = Object.values(PUZZLES).find(p => p.id === id);
  if (!puzzle) {
    return res.status(404).json({ error: 'Puzzle not found' });
  }

  const today = getEasternDateString();
  if (puzzle.date > today) {
    return res.status(403).json({ error: 'This puzzle is not available yet' });
  }

  res.json({
    puzzleNumber: getPuzzleNumberForDate(puzzle.date),
    puzzleId: puzzle.id,
    clue: puzzle.clue,
    date: puzzle.date
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

  const puzzle = Object.values(PUZZLES).find(p => p.id === puzzleId);
  if (!puzzle) {
    return res.status(404).json({ error: 'Puzzle not found' });
  }

  const today = getEasternDateString();
  if (puzzle.date > today) {
    return res.status(403).json({ error: 'This puzzle is not available yet' });
  }

  const result = checkGuess(upperGuess, puzzle.answer);
  const correct = upperGuess === puzzle.answer;

  res.json({ result, correct });
});

// GET /api/puzzles/list – all available puzzles (no answers)
app.get('/api/puzzles/list', (req, res) => {
  const available = getAvailablePuzzleDates();
  const list = available.map(dateStr => {
    const p = PUZZLES[dateStr];
    return {
      puzzleNumber: getPuzzleNumberForDate(dateStr),
      puzzleId: p.id,
      clue: p.clue,
      date: p.date
    };
  });

  const today = getEasternDateString();
  const allDates = Object.keys(PUZZLES).sort();
  const lastPuzzleDate = allDates[allDates.length - 1];
  const hasMorePuzzles = today < lastPuzzleDate;

  res.json({
    puzzles: list,
    totalPuzzles: getTotalPuzzleCount(),
    nextPuzzleTime: hasMorePuzzles ? getNextMidnightEasternUTC().toISOString() : null,
    hasMorePuzzles
  });
});

// POST /api/reveal – reveal the answer
app.post('/api/reveal', (req, res) => {
  const { puzzleId } = req.body;
  const puzzle = Object.values(PUZZLES).find(p => p.id === puzzleId);
  if (!puzzle) {
    return res.status(404).json({ error: 'Puzzle not found' });
  }
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
  console.log(`Current Eastern date: ${getEasternDateString()}`);
  console.log(`Available puzzles today: ${getAvailablePuzzleDates().length} of ${getTotalPuzzleCount()}`);
  console.log(`Next puzzle at: ${getNextMidnightEasternUTC().toISOString()}`);
});
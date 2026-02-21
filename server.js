require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Block direct static access to answer images
app.use('/images/answers', (req, res, next) => {
  res.status(403).json({ error: 'Access denied' });
});

// Block direct static access to sounds
app.use('/sounds', (req, res, next) => {
  res.status(403).json({ error: 'Access denied' });
});

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
    const rest = value.substring(pipeIndex + 1);
    const secondPipe = rest.indexOf('|');
    let clue, altWinSound = null, altLoseSound = null;
    if (secondPipe !== -1) {
      clue = rest.substring(0, secondPipe).trim();
      const soundPart = rest.substring(secondPipe + 1).trim();
      const sounds = soundPart.split(',').map(s => s.trim());
      if (sounds[0]) altWinSound = sounds[0];
      if (sounds[1]) altLoseSound = sounds[1];
    } else {
      clue = rest.trim();
    }

    if (answer.length !== 5) {
      console.warn(`Skipping ${key}: answer "${answer}" is not 5 characters`);
      continue;
    }
    if (!/^[A-Z0-9\-]+$/.test(answer)) {
      console.warn(`Skipping ${key}: answer contains invalid characters`);
      continue;
    }

    puzzleMap[dateStr] = { id: dateRaw, answer, clue, date: dateStr, altWinSound, altLoseSound };
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
// Load valid 5-letter dictionary words for guess validation
// ---------------------------------------------------------------------------
function loadValidWords() {
  const fs = require('fs');
  const filePath = path.join(__dirname, 'data', 'valid-words.txt');
  const words = new Set();

  if (fs.existsSync(filePath)) {
    const content = fs.readFileSync(filePath, 'utf-8');
    content.split('\n').forEach(line => {
      const word = line.trim().toUpperCase();
      if (word.length === 5 && /^[A-Z]+$/.test(word)) {
        words.add(word);
      }
    });
    console.log(`Loaded ${words.size} valid dictionary words`);
  } else {
    console.warn('No valid-words.txt found in data/ — only puzzle answers will be accepted as guesses');
  }

  // Add all puzzle answers as valid guesses (covers non-dictionary words like VADER)
  Object.values(PUZZLES).forEach(p => words.add(p.answer));

  return words;
}

const VALID_WORDS = loadValidWords();

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
    hasMorePuzzles,
    altWinSound: puzzle.altWinSound || null,
    altLoseSound: puzzle.altLoseSound || null
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
    date: puzzle.date,
    altWinSound: puzzle.altWinSound || null,
    altLoseSound: puzzle.altLoseSound || null
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

  if (!VALID_WORDS.has(upperGuess)) {
    return res.status(422).json({ error: 'Not in word list' });
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
      date: p.date,
      altWinSound: p.altWinSound || null,
      altLoseSound: p.altLoseSound || null
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

// GET /api/answer-image/:puzzleId – serve answer image only for completed puzzles
const imageCache = new Map(); // puzzleId -> { buffer, contentType } or null

app.get('/api/answer-image/:puzzleId', async (req, res) => {
  const id = req.params.puzzleId;
  const puzzle = Object.values(PUZZLES).find(p => p.id === id);
  if (!puzzle) {
    return res.status(404).json({ error: 'Not found' });
  }

  const today = getEasternDateString();
  if (puzzle.date > today) {
    return res.status(403).json({ error: 'Not available yet' });
  }

  // Check memory cache first
  if (imageCache.has(id)) {
    const cached = imageCache.get(id);
    if (!cached) return res.status(404).json({ error: 'No image available' });
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(cached.buffer);
  }

  // Try local file first (for local development)
  const fs = require('fs');
  const extensions = ['png', 'jpg', 'gif', 'webp'];
  const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

  for (const ext of extensions) {
    const filePath = path.join(__dirname, 'public', 'images', 'answers', `${id}.${ext}`);
    if (fs.existsSync(filePath)) {
      const buffer = fs.readFileSync(filePath);
      imageCache.set(id, { buffer, contentType: mimeTypes[ext] });
      res.set('Content-Type', mimeTypes[ext]);
      res.set('Cache-Control', 'public, max-age=86400');
      return res.send(buffer);
    }
  }

  // Try GitHub private repo
  const token = process.env.GITHUB_ASSETS_TOKEN;
  const repo = process.env.GITHUB_ASSETS_REPO;
  if (token && repo) {
    for (const ext of extensions) {
      try {
        const url = `https://raw.githubusercontent.com/${repo}/main/answers/${id}.${ext}`;
        const ghRes = await fetch(url, {
          headers: { 'Authorization': `token ${token}` }
        });
        if (ghRes.ok) {
          const arrayBuffer = await ghRes.arrayBuffer();
          const buffer = Buffer.from(arrayBuffer);
          imageCache.set(id, { buffer, contentType: mimeTypes[ext] });
          res.set('Content-Type', mimeTypes[ext]);
          res.set('Cache-Control', 'public, max-age=86400');
          return res.send(buffer);
        }
      } catch {}
    }
  }

  // Nothing found — cache the miss too
  imageCache.set(id, null);
  res.status(404).json({ error: 'No image available' });
});

// GET /api/sounds/:filename – serve sound files (local first, then GitHub private repo)
const soundCache = new Map(); // filename -> { buffer, contentType } or null

app.get('/api/sounds/:filename', async (req, res) => {
  const filename = req.params.filename;

  // Sanitize: only allow expected sound filenames
  if (!/^[\w\-]+\.(mp3|wav|ogg)$/i.test(filename)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }

  // Check memory cache first
  if (soundCache.has(filename)) {
    const cached = soundCache.get(filename);
    if (!cached) return res.status(404).json({ error: 'Sound not found' });
    res.set('Content-Type', cached.contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(cached.buffer);
  }

  const fs = require('fs');
  const mimeTypes = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg' };
  const ext = filename.split('.').pop().toLowerCase();
  const contentType = mimeTypes[ext] || 'application/octet-stream';

  // Try local file first (skip if SKIP_LOCAL_SOUNDS is set, for testing GitHub source)
  const localPath = path.join(__dirname, 'public', 'sounds', filename);
  if (!process.env.SKIP_LOCAL_SOUNDS && fs.existsSync(localPath)) {
    const buffer = fs.readFileSync(localPath);
    soundCache.set(filename, { buffer, contentType });
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(buffer);
  }

  // Try GitHub private repo
  const token = process.env.GITHUB_ASSETS_TOKEN;
  const repo = process.env.GITHUB_ASSETS_REPO;
  if (token && repo) {
    try {
      const url = `https://raw.githubusercontent.com/${repo}/main/sounds/${filename}`;
      const ghRes = await fetch(url, {
        headers: { 'Authorization': `token ${token}` }
      });
      if (ghRes.ok) {
        const arrayBuffer = await ghRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        soundCache.set(filename, { buffer, contentType });
        res.set('Content-Type', contentType);
        res.set('Cache-Control', 'public, max-age=86400');
        return res.send(buffer);
      }
    } catch {}
  }

  // Nothing found — cache the miss
  soundCache.set(filename, null);
  res.status(404).json({ error: 'Sound not found' });
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
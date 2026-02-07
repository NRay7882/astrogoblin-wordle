/* =====================================================
   Slave, Vader, Wampa, Bingo – Client Application
   ===================================================== */

(function () {
  'use strict';

  // ---- Constants ----
  const WORD_LENGTH = 5;
  const MAX_GUESSES = 6;
  const STORAGE_KEY = 'svwb_game_state';
  const VALID_CHARS = /^[A-Z0-9\-]$/;

  const KB_ROWS = [
    ['1','2','3','4','5','6','7','8','9','0','-'],
    ['Q','W','E','R','T','Y','U','I','O','P'],
    ['A','S','D','F','G','H','J','K','L'],
    ['SUBMIT','Z','X','C','V','B','N','M','DEL']
  ];

  // ---- Sound System ----
  // Tries to load custom audio files; falls back to Web Audio API tones
  const SoundManager = {
    ctx: null,
    cache: {},

    init() {
      try { this.ctx = new (window.AudioContext || window.webkitAudioContext)(); }
      catch (e) { console.warn('Web Audio API not supported'); }
    },

    ensureCtx() {
      if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
    },

    // Try to play an audio file; return false if not found
    async playFile(path) {
      try {
        if (!this.cache[path]) {
          const res = await fetch(path, { method: 'HEAD' });
          if (!res.ok) return false;
          this.cache[path] = true;
        }
        const audio = new Audio(path);
        audio.volume = 0.5;
        await audio.play();
        return true;
      } catch {
        return false;
      }
    },

    // Fallback tone via Web Audio API
    playTone(freq, duration, type = 'square') {
      this.ensureCtx();
      if (!this.ctx) return;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.15, this.ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + duration);
      osc.connect(gain).connect(this.ctx.destination);
      osc.start();
      osc.stop(this.ctx.currentTime + duration);
    },

    // Play wrong-guess sound for guess number (1-5)
    async playWrong(guessNum) {
      const played = await this.playFile(`/sounds/try${guessNum}.mp3`);
      if (played) return;
      const played2 = await this.playFile(`/sounds/try${guessNum}.wav`);
      if (played2) return;
      // Fallback: descending tone
      this.playTone(400 - (guessNum * 40), 0.3, 'square');
    },

    // Play lose sound (6th wrong guess)
    async playLose() {
      let played = await this.playFile('/sounds/lose.mp3');
      if (played) return;
      played = await this.playFile('/sounds/lose.wav');
      if (played) return;
      // Fallback: sad descending tones
      this.playTone(300, 0.2); 
      setTimeout(() => this.playTone(200, 0.4), 200);
    },

    // Play win sound
    async playWin() {
      let played = await this.playFile('/sounds/win.mp3');
      if (played) return;
      played = await this.playFile('/sounds/win.wav');
      if (played) return;
      // Fallback: happy ascending tones
      this.playTone(440, 0.15, 'sine');
      setTimeout(() => this.playTone(554, 0.15, 'sine'), 150);
      setTimeout(() => this.playTone(659, 0.15, 'sine'), 300);
      setTimeout(() => this.playTone(880, 0.3, 'sine'), 450);
    }
  };

  // ---- State ----
  let currentPuzzle = null;   // { puzzleNumber, puzzleId, clue, date }
  let gameState = {};          // All puzzle states from localStorage
  let currentGuess = '';       // Letters typed so far for current row
  let currentRow = 0;          // Which row we're on (0-5)
  let gameOver = false;        // Is the current puzzle finished?
  let isRevealing = false;     // Animation lock
  let nextPuzzleTime = null;   // UTC ISO string of next puzzle
  let countdownInterval = null;
  let allPuzzlesList = [];     // From /api/puzzles/list

  // ---- DOM refs ----
  const boardEl = document.getElementById('board');
  const toastContainer = document.getElementById('toast-container');
  const puzzleNumberEl = document.getElementById('puzzle-number');
  const puzzleClueEl = document.getElementById('puzzle-clue');
  const resultArea = document.getElementById('result-area');
  const resultMessage = document.getElementById('result-message');
  const revealBtn = document.getElementById('reveal-btn');
  const revealedAnswer = document.getElementById('revealed-answer');
  const playPrevBtn = document.getElementById('play-previous-btn');
  const countdownEl = document.getElementById('countdown');
  const puzzlesListEl = document.getElementById('puzzles-list');

  // ---- LocalStorage helpers ----
  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  }

  function saveState() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(gameState));
  }

  function getPuzzleState(puzzleId) {
    if (!gameState[puzzleId]) {
      gameState[puzzleId] = {
        guesses: [],   // [{ word, result }]
        status: 'in-progress'
      };
    }
    return gameState[puzzleId];
  }

  // ---- Toast ----
  function showToast(msg, duration = 1700) {
    const el = document.createElement('div');
    el.className = 'toast';
    el.textContent = msg;
    toastContainer.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }

  // ---- Board Rendering ----
  function createBoard() {
    boardEl.innerHTML = '';
    for (let r = 0; r < MAX_GUESSES; r++) {
      const row = document.createElement('div');
      row.className = 'board-row';
      row.dataset.row = r;
      for (let c = 0; c < WORD_LENGTH; c++) {
        const tile = document.createElement('div');
        tile.className = 'tile';
        tile.dataset.row = r;
        tile.dataset.col = c;
        row.appendChild(tile);
      }
      boardEl.appendChild(row);
    }
  }

  function getTile(row, col) {
    return boardEl.querySelector(`.tile[data-row="${row}"][data-col="${col}"]`);
  }

  function updateTileLetter(row, col, letter) {
    const tile = getTile(row, col);
    tile.textContent = letter;
    if (letter) {
      tile.classList.add('filled');
    } else {
      tile.classList.remove('filled');
    }
  }

  function setTileStatus(row, col, status) {
    const tile = getTile(row, col);
    tile.classList.remove('absent', 'present', 'correct');
    if (status) tile.classList.add(status);
  }

  // Animate reveal of a row
  function revealRow(row, result, callback) {
    isRevealing = true;
    result.forEach((item, i) => {
      setTimeout(() => {
        const tile = getTile(row, i);
        tile.classList.add('reveal');
        // Apply color halfway through flip
        setTimeout(() => {
          setTileStatus(row, i, item.status);
          updateKeyboardKey(item.letter, item.status);
        }, 150);
        if (i === WORD_LENGTH - 1) {
          setTimeout(() => {
            isRevealing = false;
            if (callback) callback();
          }, 300);
        }
      }, i * 300);
    });
  }

  // Win bounce animation
  function bounceRow(row) {
    for (let i = 0; i < WORD_LENGTH; i++) {
      setTimeout(() => {
        getTile(row, i).classList.add('win-bounce');
      }, i * 100);
    }
  }

  // Restore previous guesses on the board (no animation)
  function restoreBoard(puzzleState) {
    puzzleState.guesses.forEach((g, rowIdx) => {
      for (let c = 0; c < WORD_LENGTH; c++) {
        updateTileLetter(rowIdx, c, g.result[c].letter);
        setTileStatus(rowIdx, c, g.result[c].status);
        updateKeyboardKey(g.result[c].letter, g.result[c].status);
      }
    });
  }

  // ---- Keyboard Rendering ----
  const keyStatusMap = {}; // letter -> best status

  function createKeyboard() {
    const rowEls = [
      document.getElementById('kb-row-nums'),
      document.getElementById('kb-row-top'),
      document.getElementById('kb-row-mid'),
      document.getElementById('kb-row-bot')
    ];

    KB_ROWS.forEach((row, ri) => {
      rowEls[ri].innerHTML = '';
      row.forEach(key => {
        const btn = document.createElement('button');
        btn.className = 'key';
        btn.dataset.key = key;
        btn.textContent = key;

        if (key === 'SUBMIT' || key === 'DEL') {
          btn.classList.add('wide');
        }

        btn.addEventListener('click', () => handleKeyPress(key));
        rowEls[ri].appendChild(btn);
      });
    });
  }

  function updateKeyboardKey(letter, status) {
    const priority = { absent: 0, present: 1, correct: 2 };
    const upper = letter.toUpperCase();
    const current = keyStatusMap[upper];
    if (current && priority[current] >= priority[status]) return;
    keyStatusMap[upper] = status;

    const btn = document.querySelector(`.key[data-key="${upper}"]`);
    if (!btn) return;
    btn.classList.remove('absent', 'present', 'correct');
    btn.classList.add(status);
  }

  function resetKeyboardColors() {
    Object.keys(keyStatusMap).forEach(k => delete keyStatusMap[k]);
    document.querySelectorAll('.key').forEach(btn => {
      btn.classList.remove('absent', 'present', 'correct');
    });
  }

  // ---- Input Handling ----
  function handleKeyPress(key) {
    if (gameOver || isRevealing) return;

    if (key === 'DEL' || key === 'BACKSPACE') {
      if (currentGuess.length > 0) {
        currentGuess = currentGuess.slice(0, -1);
        updateTileLetter(currentRow, currentGuess.length, '');
      }
      return;
    }

    if (key === 'SUBMIT' || key === 'ENTER') {
      submitGuess();
      return;
    }

    const upper = key.toUpperCase();
    if (currentGuess.length < WORD_LENGTH && VALID_CHARS.test(upper)) {
      currentGuess += upper;
      updateTileLetter(currentRow, currentGuess.length - 1, upper);
    }
  }

  // Physical keyboard listener
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toUpperCase();
    if (key === 'ENTER') {
      e.preventDefault();
      handleKeyPress('SUBMIT');
    } else if (key === 'BACKSPACE') {
      handleKeyPress('DEL');
    } else if (key.length === 1 && VALID_CHARS.test(key)) {
      handleKeyPress(key);
    }
  });

  // ---- Guess Submission ----
  async function submitGuess() {
    if (currentGuess.length !== WORD_LENGTH) {
      showToast('Not enough letters');
      shakeRow(currentRow);
      return;
    }

    try {
      const res = await fetch('/api/guess', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          puzzleId: currentPuzzle.puzzleId,
          guess: currentGuess
        })
      });

      if (!res.ok) {
        const err = await res.json();
        showToast(err.error || 'Error');
        return;
      }

      const data = await res.json();
      const guessNum = currentRow + 1;
      const pState = getPuzzleState(currentPuzzle.puzzleId);

      // Save guess
      pState.guesses.push({ word: currentGuess, result: data.result });

      // Reveal the row
      revealRow(currentRow, data.result, () => {
        if (data.correct) {
          // WIN
          pState.status = 'won';
          saveState();
          gameOver = true;
          bounceRow(currentRow);
          SoundManager.playWin();
          showResult('won', guessNum);
          refreshPuzzlesList();
        } else if (guessNum >= MAX_GUESSES) {
          // LOSE
          pState.status = 'lost';
          saveState();
          gameOver = true;
          SoundManager.playLose();
          showResult('lost');
          refreshPuzzlesList();
        } else {
          // Wrong but still has guesses
          SoundManager.playWrong(guessNum);
          currentRow++;
          currentGuess = '';
          saveState();
        }
      });

      currentGuess = '';
      saveState();

    } catch (err) {
      console.error('Guess error:', err);
      showToast('Connection error. Try again.');
    }
  }

  function shakeRow(row) {
    const rowEl = boardEl.querySelector(`.board-row[data-row="${row}"]`);
    rowEl.style.animation = 'none';
    rowEl.offsetHeight; // trigger reflow
    rowEl.style.animation = 'shake 0.3s ease';
    setTimeout(() => { rowEl.style.animation = ''; }, 300);
  }

  // ---- Win / Lose ----
  function showResult(type, guessNum) {
    resultArea.classList.remove('hidden');
    resultMessage.className = '';

    if (type === 'won') {
      const messages = [
        'Genius!', 'Magnificent!', 'Impressive!',
        'Splendid!', 'Great!', 'Phew!'
      ];
      resultMessage.textContent = messages[Math.min(guessNum - 1, 5)];
      resultMessage.classList.add('win');
      revealBtn.classList.add('hidden');
      revealedAnswer.classList.add('hidden');
      playPrevBtn.classList.remove('hidden');
    } else {
      resultMessage.textContent = 'Better luck next time!';
      resultMessage.classList.add('lose');
      revealBtn.classList.remove('hidden');
      revealedAnswer.classList.add('hidden');
      playPrevBtn.classList.remove('hidden');
    }
  }

  // Reveal answer button
  revealBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ puzzleId: currentPuzzle.puzzleId })
      });
      const data = await res.json();
      revealedAnswer.textContent = `The answer was: ${data.answer}`;
      revealedAnswer.classList.remove('hidden');
      revealBtn.classList.add('hidden');
    } catch (err) {
      showToast('Error revealing answer');
    }
  });

  // Scroll to previous puzzles
  playPrevBtn.addEventListener('click', () => {
    document.getElementById('puzzles-nav').scrollIntoView({ behavior: 'smooth' });
  });

  // ---- Countdown Timer ----
  function startCountdown() {
    if (countdownInterval) clearInterval(countdownInterval);
    countdownInterval = setInterval(updateCountdown, 1000);
    updateCountdown();
  }

  function updateCountdown() {
    if (!nextPuzzleTime) { countdownEl.textContent = '--:--:--'; return; }
    const now = Date.now();
    const target = new Date(nextPuzzleTime).getTime();
    let diff = Math.max(0, target - now);

    if (diff <= 0) {
      countdownEl.textContent = '00:00:00';
      // Refresh the page to load the new puzzle after a short delay
      clearInterval(countdownInterval);
      setTimeout(() => location.reload(), 2000);
      return;
    }

    const h = Math.floor(diff / 3600000);
    diff %= 3600000;
    const m = Math.floor(diff / 60000);
    diff %= 60000;
    const s = Math.floor(diff / 1000);

    countdownEl.textContent =
      `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  // ---- Previous Puzzles List ----
  async function refreshPuzzlesList() {
    try {
      const res = await fetch('/api/puzzles/list');
      const data = await res.json();
      allPuzzlesList = data.puzzles;
      nextPuzzleTime = data.nextPuzzleTime;
      renderPuzzlesList();
    } catch (err) {
      console.error('Error loading puzzles list:', err);
    }
  }

  function renderPuzzlesList() {
    puzzlesListEl.innerHTML = '';

    // Show newest first
    const sorted = [...allPuzzlesList].reverse();

    sorted.forEach(p => {
      const pState = gameState[p.puzzleId];
      let statusClass = 'not-started';
      if (pState) {
        statusClass = pState.status === 'won' ? 'won'
          : pState.status === 'lost' ? 'lost'
          : 'in-progress';
      }

      const item = document.createElement('div');
      item.className = 'puzzle-nav-item';
      if (currentPuzzle && p.puzzleId === currentPuzzle.puzzleId) {
        item.classList.add('active');
      }

      const dateObj = new Date(p.date + 'T12:00:00');
      const dateStr = dateObj.toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric'
      });

      item.innerHTML = `
        <div class="puzzle-nav-status ${statusClass}"></div>
        <div class="puzzle-nav-info">
          <div class="puzzle-nav-title">Puzzle #${p.puzzleNumber}</div>
          <div class="puzzle-nav-date">${dateStr}</div>
        </div>
      `;

      item.addEventListener('click', () => loadPuzzle(p.puzzleNumber));
      puzzlesListEl.appendChild(item);
    });
  }

  // ---- Load a Puzzle ----
  async function loadPuzzle(puzzleNumber) {
    try {
      const res = await fetch(`/api/puzzle/${puzzleNumber}`);
      if (!res.ok) {
        const err = await res.json();
        showToast(err.error || 'Cannot load puzzle');
        return;
      }
      const data = await res.json();

      currentPuzzle = data;
      puzzleNumberEl.textContent = data.puzzleNumber;
      puzzleClueEl.textContent = data.clue;

      // Reset UI
      createBoard();
      resetKeyboardColors();
      resultArea.classList.add('hidden');
      revealBtn.classList.add('hidden');
      revealedAnswer.classList.add('hidden');
      playPrevBtn.classList.add('hidden');

      // Load saved state
      const pState = getPuzzleState(data.puzzleId);
      currentRow = pState.guesses.length;
      currentGuess = '';
      gameOver = pState.status === 'won' || pState.status === 'lost';

      // Restore board
      if (pState.guesses.length > 0) {
        restoreBoard(pState);
      }

      // Show result if already finished
      if (pState.status === 'won') {
        showResult('won', pState.guesses.length);
      } else if (pState.status === 'lost') {
        showResult('lost');
      }

      // Refresh nav highlighting
      renderPuzzlesList();

      // Scroll to top
      window.scrollTo({ top: 0, behavior: 'smooth' });

    } catch (err) {
      console.error('Error loading puzzle:', err);
      showToast('Error loading puzzle');
    }
  }

  // ---- Initialize ----
  async function init() {
    SoundManager.init();
    gameState = loadState();
    createBoard();
    createKeyboard();

    try {
      const res = await fetch('/api/today');
      const data = await res.json();
      nextPuzzleTime = data.nextPuzzleTime;

      if (!data.active && data.totalAvailable === 0) {
        puzzleClueEl.textContent = data.message || 'No puzzles available yet.';
        startCountdown();
        return;
      }

      await refreshPuzzlesList();
      await loadPuzzle(data.puzzleNumber);
      startCountdown();

    } catch (err) {
      console.error('Init error:', err);
      puzzleClueEl.textContent = 'Error loading puzzle. Please refresh.';
    }
  }

  // ---- Add shake keyframe (injected via JS since it's minor) ----
  const style = document.createElement('style');
  style.textContent = `
    @keyframes shake {
      0%, 100% { transform: translateX(0); }
      20% { transform: translateX(-4px); }
      40% { transform: translateX(4px); }
      60% { transform: translateX(-4px); }
      80% { transform: translateX(4px); }
    }
  `;
  document.head.appendChild(style);

  // ---- Start ----
  document.addEventListener('DOMContentLoaded', init);
})();
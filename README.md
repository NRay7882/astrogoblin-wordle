# Slave, Vader, Wampa, Bingo

An [Astrogoblin](https://www.patreon.com/c/Astrogoblin) community Wordle puzzle game.
This is a comment scraper for Patreon creators, specifically for the [Astrogoblin crew](https://www.patreon.com/c/Astrogoblin). It was built on my own for fun and is hosted at [astrogoblincommentviewer.com](https://astrogoblincommentviewer.com)

Build with node 25.2.1 & npm 11.6.2


## Setup

1. Install dependencies:
   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and add your puzzle data:
   ```bash
   cp .env.example .env
   ```

3. Edit `.env` with your puzzles in the format:
   ```
   PUZZLE_001=ANSWER|Clue text here
   PUZZLE_002=WORD2|Another clue
   ```

4. Start the server:
   ```bash
   npm start
   ```

5. Open `http://localhost:3000` in your browser.

## Custom Sounds

Place audio files in `public/sounds/`:

| File | When it plays |
|------|--------------|
| `wrong1.mp3` (or `.wav`) | Incorrect guess #1 |
| `wrong2.mp3` | Incorrect guess #2 |
| `wrong3.mp3` | Incorrect guess #3 |
| `wrong4.mp3` | Incorrect guess #4 |
| `wrong5.mp3` | Incorrect guess #5 |
| `lose.mp3` | 6th incorrect guess (game over) |
| `win.mp3` | Correct guess |

If no custom sounds are found, generated tones will play as fallback.

## Deploying to Render

1. Push code to GitHub (`.env` and sound files are gitignored)
2. Create a new Web Service on Render pointing to the repo
3. Set environment variables in Render's dashboard:
   - `START_DATE` 
   - `PUZZLE_001`, `PUZZLE_002`, etc.
   - `PORT` (Render sets this automatically)
4. Build command: `npm install`
5. Start command: `npm start`

## Puzzle Rules

- Each puzzle is a 5-character word (letters A-Z, numbers 0-9, hyphens)
- Players get 6 guesses
- Green = correct letter, correct position
- Yellow = correct letter, wrong position
- Gray = letter not in the word
- New puzzle available daily at midnight Eastern Time
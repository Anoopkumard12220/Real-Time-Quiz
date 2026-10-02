# Quiz Battle

A real-time multiplayer quiz game for a group of friends.

One person creates a room and adds the questions. Everyone else joins with a short
room code. When the host starts the quiz, the **same question appears on every
phone at the same time**, everyone answers from their own device, and the
**fastest correct answer scores the point**. At the end you get a leaderboard and
the lowest scorer is named as the one who gets the dare (the app never invents the
dare itself).

**Developed & Managed by Anoop Dubey**

---

## 1. What the project is

Quiz Battle is a small static web app built with plain HTML, CSS and vanilla
JavaScript. There is no build step, no framework and no server of our own — the
only backend is a **Firebase Realtime Database**, which pushes every change to
every connected device instantly.

It is designed for phones first: large tap targets, a single-column layout, a
timer that is always visible, and no horizontal scrolling.

---

## 2. File structure

The project is exactly five files:

```
/
├── index.html     # all screens (home, create, join, lobby, quiz, results) + question modal
├── style.css      # the whole design system: teal primary, coral + soft green accents
├── app.js         # all game logic: rooms, presence, questions, timer, scoring
├── firebase.js    # Firebase config + the shared server clock
└── README.md      # this file
```

There is no `package.json`, no bundler and no extra library. `app.js` and
`firebase.js` are plain scripts loaded with `<script>` tags.

---

## 3. How the multiplayer system works

Everything lives under one Firebase Realtime Database path per room:

```
rooms/{ROOM_CODE}/
  hostId          -> playerId of the host
  targetCount     -> how many questions the host aimed for
  state/          -> status ("lobby" | "playing" | "finished"), phase, currentQuestion,
                     duration, questionStartTime (server timestamp), resultAt
  questions/{id}/ -> text, options[4], correct
  players/{id}/   -> name, online, connectedAt, joinedAt      (id = crypto.randomUUID())
  answers/{n}/{playerId} -> selected, at (server timestamp)
  scored/{n}      -> playerId, name, at   (one entry per question = one point)
codes/{ROOM_CODE} -> temporary lock while the code is being created
```

**Rooms.** Creating a room reserves a 5-character code (letters and digits only,
no `O`, `0`, `I`, `1`) with a Firebase *transaction* on `codes/{CODE}`. The
transaction only succeeds if the code is still free, so two people creating a
room at the same instant can never end up with the same code. The reservation is
released as soon as the room exists.

**Listening.** Every client attaches a single `on('value')` listener to
`rooms/{CODE}`. Whatever the host, a player or the timer does, Firebase pushes the
new room state to everybody and each screen re-renders. There is no polling of
the database and no "fake" local simulation.

**The timer is synchronised, not local.** When a question starts, Firebase writes
`questionStartTime` using its own server clock. Every device calculates the
remaining time as `questionStartTime + duration - serverNow()`, where `serverNow()`
uses the offset Firebase reports at `/.info/serverTimeOffset`. Phones with wrong
clocks still see the same countdown. A device's own `setInterval` is only used
to *draw* the countdown, never to decide the outcome.

**Answering.** Tapping an option writes the answer to
`answers/{questionIndex}/{playerId}` inside a transaction that aborts if that
player already answered — so one player can never answer twice, and cannot change
an answer afterwards. Only `selected` and the Firebase server timestamp are sent
from the device.

**Scoring (fastest correct answer wins).** When a question ends — either every
online player has answered, or the timer has run out — each client works out the
winner from the stored answers: among the answers whose option matches the
correct one, the earliest `at` (a Firebase server timestamp, never the device
clock) wins. The winner is then written to `scored/{questionIndex}` in a
transaction that aborts if that question was already decided, which guarantees
exactly one point per question no matter how many devices decide at once.

**Scores are derived, not counted.** A player's score is simply the number of
entries in `scored` that name them. Because scores are computed from that map
rather than incremented, a dropped connection or a duplicated write can never
double-count a point.

**Who moves the game on.** Every client runs the same 250 ms check: "is this
question over?" and "is the result screen due?". All of those writes go through
Firebase transactions that check the current question index and phase first, so
the first client to get through wins the write and the others quietly do
nothing. This means the game keeps moving even if the host's phone is the one
that closes.

**Presence and leaving.**
- Each player sets `players/{me}/online = true` on connect and registers an
  `onDisconnect` handler that flips it to `false`, plus a heartbeat that refreshes
  `connectedAt` every 20 seconds (this also catches a hard crash).
- A player who disconnects keeps their score and is simply shown as offline.
- If the host disappears, the room is **not** destroyed. After a 3-second grace
  period (long enough for a refresh to reconnect) the longest-present online
  player claims the host role with a transaction, and the room carries on.
- When the last player leaves, the room is deleted. While the room exists, any
  player who joins cleans up nothing else — the room only disappears via an
  explicit leave by the last online player, so a forgotten room can linger in the
  database until you delete it from the Firebase console.

**Refresh / reconnect.** The player id, name and room code are kept in
`localStorage`. On load the app checks the room still contains that player id and
drops you straight back into the lobby, the live question or the leaderboard —
with the correct screen and the correct question already showing.

---

## 4. Firebase setup (one time)

1. Go to <https://console.firebase.google.com> and open the project
   **`talq-ac037`**.
2. Make sure the project is on the **Spark (free) plan** or higher.
3. Open **Build → Realtime Database** and click **Create Database**.
4. Choose a location (any one close to your friends works) and pick
   **Security rules** for the starting mode (we paste better rules below).
5. That is it — the web configuration is already in `firebase.js`.

### Where the Firebase configuration lives

All of it is in the top of **`firebase.js`**:

```js
const firebaseConfig = {
  apiKey: "...",
  authDomain: "talq-ac037.firebaseapp.com",
  projectId: "talq-ac037",
  storageBucket: "talq-ac037.firebasestorage.app",
  messagingSenderId: "529512427470",
  appId: "1:529512427470:web:0c212614b7a1947668859f"
};
```

The Firebase Web SDK is loaded from Google's CDN in `index.html`
(`firebase-app-compat.js` and `firebase-database-compat.js`). The `compat`
builds are used on purpose: they work as plain `<script>` tags on any static host,
including GitHub Pages, with no bundler and no module/CORS setup.

> The web API key is a public identifier, not a password — it is fine for it to be
> in a static site. What actually protects your data is the database security
> rules, below.

---

## 5. Security rules

This is a prototype for a private game between friends, and it is **not**
production-grade security. There is no sign-in: anyone who knows a room code can
join, read the questions and answer. That is deliberate — it keeps the app
lightweight — but it means the questions are not secret from someone who is
deliberately looking for them.

Open **Realtime Database → Rules**, paste the rules below and press **Publish**:

```json
{
  "rules": {
    ".read": false,
    ".write": false,

    "codes": {
      ".read": true,
      ".write": true
    },

    "rooms": {
      "$code": {
        ".read": true,
        ".write": true,

        "hostId": {
          ".validate": "newData.isString() && newData.val().length <= 64"
        },

        "players": {
          "$playerId": {
            ".write": true,
            ".validate": "newData.hasChildren(['name']) && newData.child('name').isString() && newData.child('name').val().length <= 24"
          }
        },

        "questions": {
          "$questionId": {
            ".write": true,
            ".validate": "newData.hasChildren(['text', 'options', 'correct']) && newData.child('text').isString() && newData.child('correct').isNumber() && newData.child('correct').val() >= 0 && newData.child('correct').val() <= 3 && newData.child('options').hasChild('0') && newData.child('options').hasChild('1') && newData.child('options').hasChild('2') && newData.child('options').hasChild('3')"
          }
        },

        "answers": {
          "$questionIndex": {
            "$playerId": {
              ".write": true,
              ".validate": "newData.hasChildren(['playerId', 'selected']) && newData.child('playerId').val() === $playerId && newData.child('selected').isNumber() && newData.child('selected').val() >= 0 && newData.child('selected').val() <= 3"
            }
          }
        },

        "scored": {
          "$questionIndex": {
            ".write": true
          }
        },

        "state": {
          ".write": true
        }
      }
    }
  }
}
```

What these rules do and do not give you:

- The **whole database is not open** — `.read` and `.write` are `false` at the
  root, so nothing outside `codes/` and `rooms/` can be touched. (`codes/` is a
  set of random room-code locks and is readable because claiming one is done
  with a transaction, which has to read the current value first.)
- Room data is readable by anyone who knows the code. That is required, because
  that is how the players' phones sync.
- A player can only write **their own** answer node, and the `playerId` inside it
  must match the key — you cannot answer on somebody else's behalf.
- Names, question text, answer options and the correct-answer index are shape
  checked (types and lengths) so a broken client cannot corrupt a room.
- They **cannot** check *who* is the host, because that would require Firebase
  Authentication. So a determined player could call the API directly to change a
  question, edit `state` or write a fake `scored` entry.

If you want that last group closed, add Firebase Authentication (anonymous sign-in
is the smallest change), put the player's uid in `players/{uid}` and gate writes
with something like `auth != null && data.child('players').child(auth.uid).child('isHost').val() === true`. That is a bigger change than this prototype needs, so it is not included here.

---

## 6. Running it locally

You need a local web server — do not open `index.html` as a `file://` path,
because browsers block Firebase on that scheme.

**Any static server works.** Pick one:

```bash
# Python (already installed almost everywhere)
python3 -m http.server 8000

# or Node
npx serve .
```

Then open <http://localhost:8000>.

To test real multiplayer on phones, run the server on your computer and open your
computer's LAN address (for example `http://192.168.1.5:8000`) on each phone, all
on the same Wi-Fi. Note that some browsers only enable the clipboard API on
HTTPS — the **Copy Code** button falls back to the old copy method when that is
the case, so it still works over plain HTTP.

---

## 7. Deploying

The project is a plain static site, so all three hosts work with no build step.

### Netlify

1. Push the five files to a GitHub repository.
2. Go to <https://app.netlify.com/drop> and drag the repository (or the folder
   with the five files) onto the page — you get a live URL immediately.
3. For a permanent site: **Add new site → Import an existing project**, pick the
   repo, and leave Build command **empty**, Publish directory as `.`.

### Vercel

```bash
npm i -g vercel
vercel            # from inside this folder
```

Answer *no* to "Is this a framework?" — it is detected as "Other". No build
command is needed. Repeat with `vercel --prod` to publish.

### GitHub Pages

1. Push the files to a repository and make sure they are on the default branch.
2. **Settings → Pages → Source: Deploy from a branch**, pick `main` and `/ (root)`.
3. Your site appears at `https://<user>.github.io/<repo>/`.

Nothing has to change in the code — all three hosts serve the same four
load-bearing files.

---

## 8. How to play

### Creating a room

1. Open the site and tap **Create Room**.
2. Enter your name, choose how many questions you want (5 / 10 / 15 / 20) and how
   long each question should be (10s is the default).
3. Tap **Create Room**. You get a five character code such as `A7K92` and you
   become the **HOST**.
4. In the lobby, tap **+ Add Question** to write a question, its four options and
   which one is correct. You can edit or delete any question before you start.
5. Share the code (there is a **Copy Code** button) and wait for friends to
   appear in the player list.

### Joining a room

1. Tap **Join Room**.
2. Enter your name and the room code, then tap **Join Room**.
3. If something is wrong you get a friendly message — *"Room not found. Please
   check the code."*, *"That quiz has already finished…"* and so on.

### During the quiz

- The host taps **Start Quiz**. Every phone moves to question 1 at the same
  moment.
- Tap one of the four options. The buttons lock, your choice turns teal and you
  see **Answer submitted ✓**. You cannot change it.
- When everyone has answered, or the timer hits zero, the correct answer turns
  soft green, your wrong answer turns soft coral, and the fastest correct player
  is named with **+1**.
- After a few seconds everyone moves to the next question together. A progress
  bar, a question counter and a compact live score strip sit above and below the
  question.

### After the quiz

- The final leaderboard is sorted by score, highest first. Ties simply show the
  same score.
- The **Dare Time** card names the lowest scorer (or everyone tied at the bottom).
  The app does not and will not decide what the dare actually is.
- The host can tap **Play Again**, which clears the answers and scores, keeps
  everyone in the room and returns everybody to the lobby so a new round can be
  prepared. Anyone can tap **Leave Room** at any time.

---

## 9. How scoring works

| Situation | Points |
| --- | --- |
| You are the first player with the **correct** answer | **+1** |
| You are correct but somebody correct faster | 0 |
| You answer incorrectly | 0 |
| Nobody answers correctly | nobody scores |
| You disconnect | you keep the points you already earned |

The order is decided by Firebase server timestamps on the answer writes, not by
which screen looked like it updated first. The winner of each question is stored
once in `scored/{questionIndex}` using a transaction, and a player's total is the
number of those entries that name them — so a point can never be awarded twice
for the same question.

---

## 10. Troubleshooting

| Symptom | What to do |
| --- | --- |
| "Room not found" | The code is wrong, the room was closed by the last player leaving, or the Realtime Database has not been created yet. |
| Page loads but nothing connects | Check the "Reconnecting…" bar and that you created the Realtime Database in the Firebase console. |
| Security rules error in the console | You skipped section 5 — paste the rules and press **Publish**. |
| Timer looks wrong on one phone | The rules above allow writes; a phone that is more than a few seconds off is fixed automatically by `/.info/serverTimeOffset`. |
| "You are now the host" too early | The previous host's connection dropped for more than 3 seconds (usually a refresh on a slow network). |
| Copy Code does nothing | Some browsers block the clipboard on plain HTTP. The code is always visible on the lobby screen. |

---

**Quiz Battle** — Developed & Managed by Anoop Dubey

/* =========================================================
   Quiz Battle — app.js
   Real-time multiplayer quiz. Firebase Realtime Database is
   the single source of truth for rooms, players, questions,
   the timer, answers and scoring.
   ========================================================= */

(function () {
  'use strict';

  var Q = window.QuizDB;
  var db = Q.db;
  var TS = Q.SERVER_TIME;

  /** Current time on the shared Firebase clock (not the device clock). */
  function now() {
    return Q.serverNow();
  }

  /* =======================================================
     1. CONSTANTS
     ======================================================= */

  var CODE_LENGTH = 5;
  // No O/0 and no I/1 — those are the characters people mistype.
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  var OPTION_KEYS = ['A', 'B', 'C', 'D'];
  var GRACE_MS = 250;      // tiny grace window so a late tap still counts
  var RESULT_MS = 4000;    // how long the "correct answer" card stays up
  var STALE_MS = 45000;    // no heartbeat for this long => treated as offline
  var HEARTBEAT_MS = 20000;
  var HOST_GRACE_MS = 3000; // host offline this long => hand over to someone else
  var TICK_MS = 250;
  var LS_KEY = 'quizbattle.session';

  /* =======================================================
     2. TINY DOM HELPERS
     ======================================================= */

  /** id -> element, and a "select many" helper. */
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function el(id) { return document.getElementById(id); }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function icon(pathD) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', pathD);
    svg.appendChild(p);
    return svg;
  }

  var ICON_EDIT = 'M4 20h4L19 9l-4-4L4 16v4z';
  var ICON_TRASH = 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13';

  /* =======================================================
     3. APP STATE
     ======================================================= */

  var S = {
    playerId: null,   // our unique identity (never the display name)
    name: '',         // display name
    code: '',         // room code we are in ('' = not in a room)
    room: null,       // latest room data straight from Firebase
    screen: 'home',   // which screen is visible
    quizKey: '',      // signature of the visible quiz content
    modal: { open: false, questionId: null, correct: 0 },
    editingCorrect: 0
  };

  /* =======================================================
     4. LOCAL SESSION (survives refresh / reconnect)
     ======================================================= */

  function loadSession() {
    try {
      var raw = localStorage.getItem(LS_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function saveSession() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({
        playerId: S.playerId, name: S.name, code: S.code
      }));
    } catch (e) { /* private mode — the app still works, just no refresh restore */ }
  }

  function clearSession() {
    try { localStorage.removeItem(LS_KEY); } catch (e) {}
  }

  /** Unique id for this device. Names are display-only (spec §23). */
  function makePlayerId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    var bytes = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return Array.prototype.map.call(bytes, function (b) {
      return ('0' + b.toString(16)).slice(-2);
    }).join('');
  }

  /* =======================================================
     5. TOASTS / ERRORS
     ======================================================= */

  var toastTimer = null;

  function toast(message) {
    var node = el('toast');
    node.textContent = message;
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, 2600);
  }

  function showError(id, message) {
    var node = el(id);
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
  }

  function hideError(id) {
    var node = el(id);
    if (node) { node.hidden = true; node.textContent = ''; }
  }

  /* =======================================================
     6. ROOM HELPERS
     ======================================================= */

  function roomRef() { return db.ref('rooms/' + S.code); }
  function playersRef() { return roomRef().child('players'); }
  function meRef() { return playersRef().child(S.playerId); }

  function makeRoomCode() {
    var out = '';
    var bytes = new Uint8Array(CODE_LENGTH);
    var rand = (window.crypto || window.msCrypto).getRandomValues.bind(window.crypto || window.msCrypto);
    rand(bytes);
    for (var i = 0; i < CODE_LENGTH; i++) {
      out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    }
    return out;
  }

  /** Short readable code, reserved atomically so two rooms never collide. */
  function reserveRoomCode(tries) {
    tries = tries === undefined ? 6 : tries;
    var code = makeRoomCode();
    return db.ref('codes/' + code).transaction(function (existing) {
      return existing === null ? true : undefined; // abort if taken
    }).then(function (res) {
      if (res.committed) return code;
      if (tries <= 1) throw new Error('CODE_EXHAUSTED');
      return reserveRoomCode(tries - 1);
    });
  }

  function questions(room) {
    var map = (room && room.questions) || {};
    return Object.keys(map).map(function (key) {
      var q = map[key];
      q.id = key;
      return q;
    });
  }

  function isOffline(player) {
    if (!player) return true;
    if (player.online !== true) return true;
    var seen = typeof player.connectedAt === 'number' ? player.connectedAt : 0;
    return seen > 0 && (now() - seen) > STALE_MS;
  }

  function playerList(room) {
    var map = (room && room.players) || {};
    return Object.keys(map).map(function (id) {
      return { id: id, name: map[id].name || 'Player', data: map[id] };
    }).sort(function (a, b) {
      var ta = a.data.joinedAt || 0, tb = b.data.joinedAt || 0;
      if (ta !== tb) return ta - tb;
      return a.name.localeCompare(b.name);
    });
  }

  function onlineIds(room) {
    return playerList(room)
      .filter(function (p) { return !isOffline(p.data); })
      .map(function (p) { return p.id; });
  }

  /** Scores are derived from the `scored` map, so they can never double count. */
  function scores(room) {
    var out = {};
    playerList(room).forEach(function (p) { out[p.id] = 0; });
    var scored = (room && room.scored) || {};
    Object.keys(scored).forEach(function (i) {
      var winnerId = scored[i] && scored[i].playerId;
      if (winnerId) out[winnerId] = (out[winnerId] || 0) + 1;
    });
    return out;
  }

  function gameState(room) {
    var raw = (room && room.state) || {};
    var s = {
      status: raw.status || 'lobby',
      phase: raw.phase || (raw.status === 'playing' ? 'question' : 'lobby'),
      currentQuestion: typeof raw.currentQuestion === 'number' ? raw.currentQuestion : 0,
      duration: typeof raw.duration === 'number' ? raw.duration : 10,
      questionStartTime: typeof raw.questionStartTime === 'number' ? raw.questionStartTime : 0,
      resultAt: typeof raw.resultAt === 'number' ? raw.resultAt : 0
    };
    return s;
  }

  function myAnswer(room) {
    var s = gameState(room);
    var bucket = (room.answers && room.answers[s.currentQuestion]) || null;
    return bucket ? bucket[S.playerId] || null : null;
  }

  /* =======================================================
     7. SCREENS
     ======================================================= */

  function showScreen(name) {
    if (S.screen === name) return;      // no needless re-render / scroll jumps
    S.screen = name;
    if (name !== 'quiz') S.quizKey = '';
    $$('.screen').forEach(function (screen) {
      screen.classList.toggle('is-active', screen.id === 'screen-' + name);
    });
    window.scrollTo(0, 0);
  }

  /* =======================================================
     8. CREATE / JOIN
     ======================================================= */

  var createCount = 5;
  var createDuration = 10;

  function setChipGroup(groupId, value) {
    $$(groupId + ' .chip').forEach(function (chip) {
      var chipValue = chip.dataset.count !== undefined ? chip.dataset.count : chip.dataset.duration;
      chip.classList.toggle('is-active', String(chipValue) === String(value));
    });
  }

  function createRoom() {
    var name = el('create-name').value.trim();
    hideError('create-error');

    if (!name) { showError('create-error', 'Please enter your name first.'); return; }

    var btn = el('btn-create-room');
    btn.disabled = true;
    btn.textContent = 'Creating room…';

    reserveRoomCode().then(function (code) {
      var room = {
        code: code,
        hostId: S.playerId,
        createdAt: TS,
        targetCount: createCount,
        state: {
          status: 'lobby',
          phase: 'lobby',
          currentQuestion: 0,
          duration: createDuration,
          questionStartTime: 0,
          resultAt: 0
        },
        players: {},
        questions: {},
        answers: {},
        scored: {}
      };
      room.players[S.playerId] = {
        name: name,
        online: true,
        connectedAt: TS,
        joinedAt: TS
      };
      return roomRefFor(code).set(room).then(function () {
        return db.ref('codes/' + code).remove(); // free the reservation
      }).then(function () {
        S.name = name;
        S.code = code;
        saveSession();
        attachRoom();
      });
    }).catch(function () {
      showError('create-error', 'Could not create a room right now. Please try again.');
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Create Room';
    });
  }

  function roomRefFor(code) { return db.ref('rooms/' + code); }

  function joinRoom() {
    var name = el('join-name').value.trim();
    var code = el('join-code').value.trim().toUpperCase();
    hideError('join-error');

    if (!name) { showError('join-error', 'Please enter your name first.'); return; }
    if (!code) { showError('join-error', 'Please enter the room code.'); return; }

    var btn = el('btn-join-room');
    btn.disabled = true;
    btn.textContent = 'Joining…';

    var ref = db.ref('rooms/' + code);

    ref.once('value').then(function (snap) {
      if (!snap.exists()) throw new Error('NOT_FOUND');

      var room = snap.val();
      var state = (room && room.state) || {};
      if (state.status === 'finished') {
        throw new Error('FINISHED');
      }

      // Write only our own player node so two people joining at the same
      // moment can never overwrite each other.
      S.name = name;
      S.code = code;
      return ref.child('players').child(S.playerId).set({
        name: name,
        online: true,
        connectedAt: TS,
        joinedAt: TS
      });
    }).then(function () {
      saveSession();
      attachRoom();
    }).catch(function (err) {
      S.code = '';
      var code_ = err && err.message;
      if (code_ === 'NOT_FOUND') showError('join-error', 'Room not found. Please check the code.');
      else if (code_ === 'FINISHED') showError('join-error', 'That quiz has already finished. Ask the host to play again.');
      else showError('join-error', 'Could not join the room. Check your connection and try again.');
    }).then(function () {
      btn.disabled = false;
      btn.textContent = 'Join Room';
    });
  }

  /* =======================================================
     9. PRESENCE + HOST ROLE
     ======================================================= */

  function attachRoom() {
    bindRoomListener();
    registerPresence();
    startTicker();
    showScreen('lobby');
  }

  function bindRoomListener() {
    if (S.boundRef) S.boundRef.off('value', onRoomValue);
    S.boundRef = roomRef();
    S.boundRef.on('value', onRoomValue, function () {
      toast('Connection lost. Trying to reconnect…');
    });
  }

  function onRoomValue(snap) {
    if (!snap.exists()) {
      // Room was deleted (for example the last player left).
      if (S.code) {
        teardownRoom();
        clearSession();
        showScreen('home');
        toast('That room has closed.');
      }
      return;
    }
    S.room = snap.val();
    render();
    checkHostHandOver();
  }

  function registerPresence() {
    // Mark ourselves online, and let Firebase flip it off if we vanish.
    // `update` (not `set`) so the name and join time are never wiped.
    meRef().update({ name: S.name, online: true, connectedAt: TS }).catch(ignore);
    meRef().onDisconnect().update({ online: false, disconnectedAt: TS }).catch(ignore);

    // Re-assert once, in case a stale disconnect from a previous session
    // (for example straight after a refresh) landed after our first write.
    setTimeout(function () {
      if (S.code) meRef().update({ online: true, connectedAt: TS }).catch(ignore);
    }, 1500);

    if (S.heartbeat) clearInterval(S.heartbeat);
    S.heartbeat = setInterval(function () {
      if (!S.code) return;
      // Keeps `connectedAt` fresh so a hard crash is noticed too.
      meRef().update({ online: true, connectedAt: TS }).catch(ignore);
    }, HEARTBEAT_MS);
  }

  /** Swallow a background write that failed because we just left the room. */
  function ignore() {}

  /**
   * If the host is gone, hand the role to the longest-present online player.
   * A short grace period means a host who refreshes keeps their role.
   */
  var hostOfflineSince = 0;
  var hostClaimAt = 0;

  function checkHostHandOver() {
    var room = S.room;
    if (!room) return;
    var hostId = room.hostId;
    var host = (room.players || {})[hostId];

    if (hostId === S.playerId || !isOffline(host)) { hostOfflineSince = 0; return; }
    if (isOffline(me())) return;                       // I am gone too
    if (!hostOfflineSince) hostOfflineSince = now();
    if (now() - hostOfflineSince < HOST_GRACE_MS) return;
    if (now() - hostClaimAt < 2000) return;           // don't spam the server
    hostClaimAt = now();

    var players = room.players || {};
    roomRef().child('hostId').transaction(function (current) {
      var currentPlayer = players[current];
      if (current === S.playerId) return;                        // already mine
      if (currentPlayer && !isOffline(currentPlayer)) return;    // host is fine
      return S.playerId;
    }).then(function (res) {
      if (res && res.committed && res.snapshot && res.snapshot.val() === S.playerId) {
        toast('You are now the host of this room.');
      }
    }).catch(function () { /* another player took it first */ });
  }

  function me() {
    return (S.room && S.room.players && S.room.players[S.playerId]) || null;
  }

  function isHost() {
    return !!(S.room && S.room.hostId === S.playerId);
  }

  function teardownRoom() {
    if (S.boundRef) { S.boundRef.off('value', onRoomValue); S.boundRef = null; }
    if (S.heartbeat) { clearInterval(S.heartbeat); S.heartbeat = null; }
    if (S.code) {
      // Stop the "mark me offline" handler, otherwise it would fire when this
      // tab closes and remove the player we are about to remove anyway.
      try { meRef().onDisconnect().cancel().catch(ignore); } catch (e) {}
    }
    S.room = null;
    S.code = '';
    S.quizKey = '';
    hostOfflineSince = 0;
    stopTicker();
  }

  function leaveRoom() {
    if (!S.code) { showScreen('home'); return; }
    var code = S.code;
    var ref = db.ref('rooms/' + code);
    var wasHost = S.room && S.room.hostId === S.playerId;
    var players = (S.room && S.room.players) || {};
    var others = Object.keys(players).filter(function (id) {
      return id !== S.playerId && !isOffline(players[id]);
    });

    teardownRoom();
    clearSession();
    showScreen('home');

    if (others.length > 0) {
      if (wasHost) ref.child('hostId').set(others[0]).catch(ignore);  // hand the room over
      ref.child('players').child(S.playerId).remove().catch(ignore);
    } else {
      ref.remove().catch(ignore);                                       // last one out closes the room
    }
  }

  /* =======================================================
     10. RENDER
     ======================================================= */

  function render() {
    if (!S.room) return;
    var state = gameState(S.room);

    if (state.status === 'playing') { renderQuizScreen(); return; }
    if (state.status === 'finished') { renderResultsScreen(); return; }
    renderLobbyScreen();
  }

  /* ---------- lobby ---------- */

  function renderLobbyScreen() {
    showScreen('lobby');
    var room = S.room;
    var host = isHost();
    var list = playerList(room);
    var qs = questions(room);
    var target = room.targetCount || qs.length || 5;

    el('lobby-code').textContent = S.code;
    el('lobby-count').textContent = String(list.length);
    el('lobby-qcount').textContent = qs.length + '/' + target;

    // players
    var listNode = el('lobby-players');
    clear(listNode);
    list.forEach(function (p) {
      var row = make('li', 'player' + (p.id === S.playerId ? ' is-me' : '') + (isOffline(p.data) ? ' is-offline' : ''));
      row.appendChild(make('span', null, '👤'));
      row.appendChild(make('span', 'player__name', p.name + (p.id === S.playerId ? ' (you)' : '')));
      if (room.hostId === p.id) row.appendChild(make('span', 'player__tag', 'HOST'));
      if (isOffline(p.data)) row.appendChild(make('span', 'player__tag', 'OFFLINE'));
      listNode.appendChild(row);
    });

    el('lobby-waiting').hidden = list.length > 1;
    el('lobby-waiting').textContent = host
      ? 'Share the code — the quiz starts when you are ready.'
      : 'Share the code with more friends if you like.';

    // questions
    var qList = el('lobby-questions');
    clear(qList);
    qs.forEach(function (q, index) {
      var item = make('li', 'q-item');
      item.appendChild(make('span', 'q-item__num', String(index + 1)));
      item.appendChild(make('span', 'q-item__text', q.text));
      if (host) {
        var actions = make('div', 'q-item__actions');

        var edit = make('button', 'q-item__btn');
        edit.type = 'button';
        edit.setAttribute('aria-label', 'Edit question ' + (index + 1));
        edit.appendChild(icon(ICON_EDIT));
        edit.addEventListener('click', function () { openQuestionModal(q); });

        var del = make('button', 'q-item__btn q-item__btn--del');
        del.type = 'button';
        del.setAttribute('aria-label', 'Delete question ' + (index + 1));
        del.appendChild(icon(ICON_TRASH));
        del.addEventListener('click', function () { deleteQuestion(q.id); });

        actions.appendChild(edit);
        actions.appendChild(del);
        item.appendChild(actions);
      }
      qList.appendChild(item);
    });

    el('lobby-qempty').hidden = qs.length > 0;
    el('btn-add-question').hidden = !host;

    // host controls
    var startBtn = el('btn-start-quiz');
    startBtn.hidden = !host;
    startBtn.disabled = qs.length === 0;
    startBtn.textContent = qs.length === 0
      ? 'Add questions to start'
      : (qs.length < target ? 'Start Quiz (' + qs.length + ' questions)' : 'Start Quiz');
    el('lobby-waiting-host').hidden = host;
    if (!host) el('lobby-waiting-host').textContent = 'Waiting for host to start…';
  }

  /* ---------- quiz ---------- */

  function renderQuizScreen() {
    showScreen('quiz');
    var room = S.room;
    var state = gameState(room);
    var qs = questions(room);
    var q = qs[state.currentQuestion];
    var mine = myAnswer(room);

    el('quiz-code').textContent = S.code;
    el('progress-label').textContent = 'Question ' + Math.min(state.currentQuestion + 1, qs.length) + ' of ' + qs.length;

    // Rebuild the question area only when something visible changed.
    var key = [state.phase, state.currentQuestion, q ? q.id : '-', q ? q.text : '-', mine ? mine.selected : '-'].join('|');
    if (key !== S.quizKey) {
      S.quizKey = key;
      buildProgress(qs, state);
      buildQuestionCard(q, state, mine);
      if (state.phase === 'result') buildResultCard(q, room, state);
    }

    updateProgressAnswered(room, state);
    updateScoreStrip(room);
  }

  function buildProgress(qs, state) {
    var dots = el('progress-dots');
    clear(dots);
    qs.forEach(function (_, i) {
      var dot = make('span', 'dot');
      if (i < state.currentQuestion) dot.classList.add('is-done');
      else if (i === state.currentQuestion && state.phase === 'question') dot.classList.add('is-current');
      dots.appendChild(dot);
    });
  }

  /**
   * Answer buttons carry the states from the design spec:
   * white = open, teal = your locked-in answer, soft green = correct,
   * soft coral = your wrong answer, grey = closed.
   */
  function buildQuestionCard(q, state, mine) {
    var isResult = state.phase === 'result';
    el('q-index').textContent = 'QUESTION ' + pad(state.currentQuestion + 1);
    el('q-text').textContent = q ? q.text : 'Loading…';
    el('phase-result').hidden = !isResult;
    el('submitted').hidden = !mine || isResult;

    var wrap = el('answers');
    clear(wrap);

    var locked = isResult || !!mine || timeRemaining(state) <= 0;

    (q && q.options ? q.options : []).forEach(function (text, i) {
      var btn = make('button', 'ans');
      btn.type = 'button';
      btn.appendChild(make('span', 'ans__key', OPTION_KEYS[i]));
      btn.appendChild(make('span', 'ans__text', text));

      if (isResult) {
        if (q.correct === i) btn.classList.add('is-correct');
        else if (mine && mine.selected === i) btn.classList.add('is-wrong');
      } else if (mine && mine.selected === i) {
        btn.classList.add('is-selected');
      }

      btn.disabled = locked;
      if (!locked) btn.addEventListener('click', function () { submitAnswer(i); });
      wrap.appendChild(btn);
    });
  }

  function buildResultCard(q, room, state) {
    var scored = (room.scored && room.scored[state.currentQuestion]) || null;
    var hasWinner = !!(scored && scored.playerId);
    el('result-answer').textContent = (q && q.options)
      ? (OPTION_KEYS[q.correct] + '. ' + q.options[q.correct])
      : '—';
    el('result-fastest').classList.toggle('fastest--none', !hasWinner);
    el('result-winner').textContent = hasWinner ? (scored.name || 'Player') : 'Nobody got it this time';
    el('result-points').textContent = hasWinner ? '+1' : '+0';
    el('next-hint').textContent = state.currentQuestion + 1 < questions(room).length
      ? 'Next question coming up…'
      : 'Final scores coming up…';
  }

  function updateProgressAnswered(room, state) {
    var bucket = (room.answers && room.answers[state.currentQuestion]) || {};
    var count = Object.keys(bucket).length;
    var total = onlineIds(room).length || 1;
    el('progress-answered').textContent = state.phase === 'result'
      ? 'Question done'
      : count + ' / ' + total + ' answered';
  }

  function updateScoreStrip(room) {
    var points = scores(room);
    var list = playerList(room).sort(function (a, b) { return points[b.id] - points[a.id]; });
    var top = list.slice(0, 8);
    var leaderId = top.length ? top[0].id : null;

    var strip = el('score-strip');
    clear(strip);
    top.forEach(function (p) {
      var chip = make('div', 'score-chip' + (p.id === S.playerId ? ' is-me' : '') + (p.id === leaderId && points[p.id] > 0 ? ' is-leader' : ''));
      chip.appendChild(make('span', null, p.name));
      chip.appendChild(make('span', 'score-chip__pts', String(points[p.id])));
      strip.appendChild(chip);
    });
  }

  /* ---------- results ---------- */

  function renderResultsScreen() {
    showScreen('results');
    var room = S.room;
    var points = scores(room);
    var list = playerList(room).sort(function (a, b) {
      if (points[b.id] !== points[a.id]) return points[b.id] - points[a.id];
      return a.name.localeCompare(b.name);
    });

    var board = el('board');
    clear(board);
    var lastScore = null, lastRank = 0;
    list.forEach(function (p, i) {
      var rank = points[p.id] === lastScore ? lastRank : i + 1;
      lastScore = points[p.id];
      lastRank = rank;

      var row = make('li', 'board__row' + (p.id === S.playerId ? ' is-me' : '') + (rank === 1 && list.length > 1 ? ' is-top' : ''));
      row.appendChild(make('span', 'board__rank', String(rank)));
      var name = make('span', 'board__name', p.name);
      if (p.id === S.playerId) name.appendChild(make('small', null, 'that is you'));
      row.appendChild(name);
      row.appendChild(make('span', 'board__pts', String(points[p.id])));
      board.appendChild(row);
    });

    // Lowest scorer(s) get the dare — the app never invents the dare itself.
    var lowest = list.length ? points[list[list.length - 1].id] : 0;
    var losers = list.filter(function (p) { return points[p.id] === lowest; });
    el('dare-name').textContent = losers.length
      ? losers.map(function (p) { return p.name; }).join(' & ')
      : '—';
    el('results-sub').textContent = questions(room).length + ' questions · ' + list.length + ' players';

    var host = isHost();
    el('btn-play-again').hidden = !host;
    el('results-waiting').hidden = host;
  }

  /* =======================================================
     11. THE GAME LOOP
     Every client runs the same checks on a timer, and every
     state change goes through a Firebase transaction, so two
     phones pressing at the same instant can never double count.
     ======================================================= */

  function timeRemaining(state) {
    if (state.phase !== 'question') return 0;
    if (!state.questionStartTime) return state.duration * 1000;
    return Math.max(0, state.questionStartTime + state.duration * 1000 - now());
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function startTicker() {
    if (S.ticker) return;
    S.ticker = setInterval(tick, TICK_MS);
    tick();
  }

  function stopTicker() {
    if (S.ticker) { clearInterval(S.ticker); S.ticker = null; }
  }

  function tick() {
    if (!S.room || S.screen === 'home' || S.screen === 'create' || S.screen === 'join') return;
    var state = gameState(S.room);
    updateTimer(state);
    runDriver();
  }

  function updateTimer(state) {
    if (S.screen !== 'quiz') return;
    var left = timeRemaining(state);
    var secs = Math.ceil(left / 1000);
    var value = state.phase === 'result' ? '00:00' : pad(Math.max(0, secs));
    var node = el('timer-value');
    if (node.textContent !== value) node.textContent = value;
    var box = el('quiz-timer');
    box.classList.toggle('is-low', state.phase === 'question' && left <= 3000);

    // Time is up: close the answers right away, without waiting for the
    // result phase to arrive.
    if (state.phase === 'question' && left <= 0) {
      $$('#answers .ans').forEach(function (btn) { btn.disabled = true; });
    }
  }

  function runDriver() {
    if (!S.room) return;
    var state = gameState(S.room);
    if (state.status !== 'playing') return;

    var qs = questions(S.room);
    if (!qs.length) return;
    var i = state.currentQuestion;
    var decided = (S.room.scored && S.room.scored[i]) || null;

    // 1. Has the question finished? (everyone answered, or time is up)
    if (state.phase === 'question') {
      var bucket = (S.room.answers && S.room.answers[i]) || {};
      var ids = onlineIds(S.room);
      var allAnswered = ids.length > 0 && ids.every(function (id) { return !!bucket[id]; });
      var timeUp = timeRemaining(state) <= 0;
      var settled = now() - state.questionStartTime >= state.duration * 1000 + GRACE_MS;

      if (decided) {
        revealResult(i);            // safety net if the deciding client vanished
      } else if (allAnswered || (timeUp && settled)) {
        decideQuestion(i, qs[i], bucket, settled);
      }
      return;
    }

    // 2. Is it time to move on?
    if (state.phase === 'result' && state.resultAt &&
        now() - state.resultAt >= RESULT_MS) {
      advance(i, qs.length);
    }
  }

  /* Small throttles so a client never hammers the database while it is
     waiting for its own write to come back down. */
  var decideAttemptAt = {};
  var revealAttemptAt = {};
  var advanceAttemptAt = {};

  /**
   * The fastest CORRECT answer (by Firebase server timestamp) takes the point.
   * A transaction on `scored/{i}` guarantees exactly one winner per question.
   */
  function decideQuestion(index, question, bucket, settled) {
    if (now() - (decideAttemptAt[index] || 0) < 600) return;
    decideAttemptAt[index] = now();

    var winnerId = null, winnerName = null, bestAt = null, unresolved = false;
    Object.keys(bucket).forEach(function (id) {
      var a = bucket[id];
      if (!a) return;
      if (typeof a.at !== 'number') { unresolved = true; return; }
      if (a.selected !== question.correct) return;
      if (bestAt === null || a.at < bestAt) { bestAt = a.at; winnerId = id; }
    });

    // Firebase swaps {".sv": "timestamp"} for the real time a moment later.
    // Wait for it, unless the question is already long over.
    if (unresolved && !settled) return;

    if (winnerId) {
      var p = (S.room.players || {})[winnerId];
      winnerName = p ? p.name : 'Player';
    }

    roomRef().child('scored').child(index).transaction(function (current) {
      if (current !== null) return undefined;  // somebody already decided
      return { playerId: winnerId, name: winnerName, at: TS };
    }).then(function (res) {
      if (res && res.committed) revealResult(index);
    }).catch(function () { /* handled by the next tick */ });
  }

  function revealResult(index) {
    if (now() - (revealAttemptAt[index] || 0) < 600) return;
    revealAttemptAt[index] = now();
    roomRef().child('state').transaction(function (s) {
      if (!s || s.phase !== 'question' || s.currentQuestion !== index) return undefined;
      s.phase = 'result';
      s.resultAt = TS;
      return s;
    }).catch(function () { /* handled by the next tick */ });
  }

  function advance(index, total) {
    if (now() - (advanceAttemptAt[index] || 0) < 600) return;
    advanceAttemptAt[index] = now();
    roomRef().child('state').transaction(function (s) {
      if (!s || s.phase !== 'result' || s.currentQuestion !== index) return undefined;
      if (index + 1 < total) {
        s.currentQuestion = index + 1;
        s.phase = 'question';
        s.questionStartTime = TS;
        s.resultAt = 0;
      } else {
        s.phase = 'done';
        s.status = 'finished';
      }
      return s;
    }).catch(function () { /* handled by the next tick */ });
  }

  /* =======================================================
     12. PLAYER ACTIONS
     ======================================================= */

  function submitAnswer(selected) {
    if (!S.room) return;
    var state = gameState(S.room);
    if (state.phase !== 'question') return;
    if (timeRemaining(state) <= 0) return;
    if (myAnswer(S.room)) return;

    // One write per player per question. The transaction is the guard.
    roomRef().child('answers').child(state.currentQuestion).child(S.playerId)
      .transaction(function (current) {
        if (current !== null) return undefined;          // already answered
        return { playerId: S.playerId, name: S.name, selected: selected, at: TS };
      })
      .then(function (res) {
        if (!res || !res.committed) toast('You already answered this question.');
      })
      .catch(function () { toast('Could not send your answer. Check your connection.'); });
  }

  function startQuiz() {
    if (!isHost()) return;
    var qs = questions(S.room);
    if (!qs.length) { toast('Add at least one question first.'); return; }

    roomRef().child('state').transaction(function (s) {
      if (!s || s.status !== 'lobby') return undefined;
      s.status = 'playing';
      s.phase = 'question';
      s.currentQuestion = 0;
      s.questionStartTime = TS;
      s.resultAt = 0;
      return s;
    }).catch(function () { toast('Could not start the quiz. Try again.'); });
  }

  function playAgain() {
    if (!isHost()) return;
    var ref = roomRef();
    ref.child('answers').remove();
    ref.child('scored').remove();
    ref.child('state').transaction(function (s) {
      if (!s) return undefined;
      s.status = 'lobby';
      s.phase = 'lobby';
      s.currentQuestion = 0;
      s.questionStartTime = 0;
      s.resultAt = 0;
      return s;
    }).then(function () {
      S.quizKey = '';
      decideAttemptAt = {};
      revealAttemptAt = {};
      advanceAttemptAt = {};
      toast('New round ready. Add questions or start again.');
    }).catch(function () { toast('Could not restart the quiz.'); });
  }

  /* ---------- question editor (host only) ---------- */

  function saveQuestion() {
    if (!isHost()) return;
    var text = el('m-q').value.trim();
    var options = $$('#modal [data-opt]').map(function (input) { return input.value.trim(); });
    var correct = S.editingCorrect;
    hideError('m-error');

    if (!text) { showError('m-error', 'Please enter the question text.'); return; }
    if (options.some(function (o) { return !o; })) { showError('m-error', 'Please fill in all four answer options.'); return; }
    if (new Set(options.map(function (o) { return o.toLowerCase(); })).size !== 4) {
      showError('m-error', 'The four options must be different from each other.');
      return;
    }

    var payload = { text: text, options: options, correct: correct };
    var id = S.modal.questionId;
    var write = id
      ? roomRef().child('questions').child(id).update(payload)
      : roomRef().child('questions').push(payload);

    write.then(function () { closeQuestionModal(); })
      .catch(function () { showError('m-error', 'Could not save the question. Try again.'); });
  }

  function deleteQuestion(id) {
    if (!isHost()) return;
    roomRef().child('questions').child(id).remove()
      .catch(function () { toast('Could not delete that question.'); });
  }

  function openQuestionModal(question) {
    S.modal.open = true;
    S.modal.questionId = question ? question.id : null;
    S.editingCorrect = question ? question.correct : 0;

    el('modal-title').textContent = question ? 'Edit Question' : 'Add Question';
    el('m-save').textContent = question ? 'Update Question' : 'Save Question';
    el('m-q').value = question ? question.text : '';
    $$('#modal [data-opt]').forEach(function (input, i) {
      var value = question && question.options ? question.options[i] : '';
      input.value = value || '';
    });
    setCorrectChip(S.editingCorrect);
    hideError('m-error');
    el('modal').hidden = false;
    setTimeout(function () { el('m-q').focus(); }, 60);
  }

  function closeQuestionModal() {
    S.modal.open = false;
    S.modal.questionId = null;
    el('modal').hidden = true;
  }

  function setCorrectChip(value) {
    S.editingCorrect = value;
    $$('#m-correct .chip').forEach(function (chip) {
      chip.classList.toggle('is-active', Number(chip.dataset.correct) === value);
    });
  }

  /* =======================================================
     13. COPY ROOM CODE
     ======================================================= */

  function copyCode() {
    var code = S.code;
    var done = function () { toast('Room code copied: ' + code); };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(code).then(done, fallbackCopy);
    } else {
      fallbackCopy();
    }
    function fallbackCopy() {
      var input = document.createElement('textarea');
      input.value = code;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      try { document.execCommand('copy'); done(); }
      catch (e) { toast('Room code: ' + code); }
      document.body.removeChild(input);
    }
  }

  /* =======================================================
     14. BOOT
     ======================================================= */

  function bindUi() {
    // home
    el('btn-go-create').addEventListener('click', function () {
      hideError('create-error'); showScreen('create');
    });
    el('btn-go-join').addEventListener('click', function () {
      hideError('join-error'); showScreen('join');
    });
    $$('[data-go="home"]').forEach(function (btn) {
      btn.addEventListener('click', function () { showScreen('home'); });
    });

    // create
    el('create-count').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      createCount = Number(chip.dataset.count);
      setChipGroup('#create-count', createCount);
    });
    el('create-duration').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      createDuration = Number(chip.dataset.duration);
      setChipGroup('#create-duration', createDuration);
    });
    setChipGroup('#create-count', createCount);
    setChipGroup('#create-duration', createDuration);
    el('btn-create-room').addEventListener('click', createRoom);

    // join
    el('btn-join-room').addEventListener('click', joinRoom);
    el('join-code').addEventListener('input', function (e) {
      e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    });
    el('join-name').addEventListener('keydown', function (e) { if (e.key === 'Enter') joinRoom(); });
    el('join-code').addEventListener('keydown', function (e) { if (e.key === 'Enter') joinRoom(); });

    // lobby
    el('btn-copy-code').addEventListener('click', copyCode);
    el('btn-add-question').addEventListener('click', function () { openQuestionModal(null); });
    el('btn-start-quiz').addEventListener('click', startQuiz);
    el('btn-leave-lobby').addEventListener('click', leaveRoom);
    el('btn-quit-quiz').addEventListener('click', leaveRoom);

    // results
    el('btn-play-again').addEventListener('click', playAgain);
    el('btn-leave-results').addEventListener('click', leaveRoom);

    // question modal
    el('m-correct').addEventListener('click', function (e) {
      var chip = e.target.closest('.chip');
      if (!chip) return;
      setCorrectChip(Number(chip.dataset.correct));
    });
    el('m-save').addEventListener('click', saveQuestion);
    $$('[data-close-modal]').forEach(function (node) {
      node.addEventListener('click', closeQuestionModal);
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && S.modal.open) closeQuestionModal();
    });

    // connection banner
    db.ref('.info/connected').on('value', function (snap) {
      el('offline-bar').hidden = snap.val() === true;
    });
  }

  function boot() {
    S.playerId = makePlayerId();
    bindUi();

    var session = loadSession();
    if (session && session.name) {
      // Nice touch: remember the display name between visits.
      el('create-name').value = session.name;
      el('join-name').value = session.name;
    }
    if (!session || !session.code) { showScreen('home'); return; }

    // Restore the session after a refresh or reconnect (spec §25).
    S.playerId = session.playerId || S.playerId;
    S.name = session.name || 'Player';
    S.code = session.code;

    roomRefFor(S.code).once('value').then(function (snap) {
      var room = snap.val();
      var stillThere = room && room.players && room.players[S.playerId];
      if (!stillThere) {
        // We left (or the room closed) while away. Back to a clean home screen.
        teardownRoom();
        clearSession();
        showScreen('home');
        return;
      }
      attachRoom();
      S.name = stillThere.name || S.name;
    }).catch(function () {
      teardownRoom();
      clearSession();
      showScreen('home');
    });
  }

  document.addEventListener('DOMContentLoaded', boot);
})();

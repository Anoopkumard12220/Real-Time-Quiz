/* =========================================================
   Quiz Battle — firebase.js
   Firebase initialisation + server clock helpers.
   Loaded BEFORE app.js. Exposes window.QuizDB.
   ========================================================= */

const firebaseConfig = {
  apiKey: "AIzaSyBl2RFYMEM_duCTq_XNQ8zT_yfRd8y1D8c",
  authDomain: "talq-ac037.firebaseapp.com",
  projectId: "talq-ac037",
  storageBucket: "talq-ac037.firebasestorage.app",
  messagingSenderId: "529512427470",
  appId: "1:529512427470:web:0c212614b7a1947668859f"
};

// Initialise the app (compat build = no modules, works on any static host).
firebase.initializeApp(firebaseConfig);

// The Realtime Database handle. Everything in the app goes through this.
const db = firebase.database();

/* ------------------------------------------------------------
   SERVER CLOCK
   The game's timer and answer ordering must NOT depend on a
   device's own clock. Firebase exposes the difference between its
   server time and this device's clock at:
       /.info/serverTimeOffset   (milliseconds)
   We track it and expose a single `serverNow()` helper so every
   screen shows the same remaining time.
   ------------------------------------------------------------ */
let serverOffset = 0;

db.ref(".info/serverTimeOffset").on("value", function (snap) {
  const value = snap.val();
  serverOffset = typeof value === "number" ? value : 0;
});

/** Current time as Firebase sees it (device clock + measured offset). */
function serverNow() {
  return Date.now() + serverOffset;
}

/** Server-assigned timestamp placeholder — resolved by Firebase, not the client. */
const SERVER_TIME = firebase.database.ServerValue.TIMESTAMP;

window.QuizDB = {
  config: firebaseConfig,
  db: db,
  serverNow: serverNow,
  serverOffset: function () {
    return serverOffset;
  },
  SERVER_TIME: SERVER_TIME
};

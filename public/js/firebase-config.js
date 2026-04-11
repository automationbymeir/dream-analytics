// firebase-config.js
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js';
import { getAnalytics } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-analytics.js';
import { getAuth, connectAuthEmulator } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import { getFirestore, connectFirestoreEmulator } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { getFunctions, connectFunctionsEmulator } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-functions.js';

const firebaseConfig = {
  apiKey: 'AIzaSyBUmGhmZkktNU-_QwFtERl-T6oRf-_sAgQ',
  authDomain: 'dreamanalysis-39322.firebaseapp.com',
  projectId: 'dreamanalysis-39322',
  storageBucket: 'dreamanalysis-39322.firebasestorage.app',
  messagingSenderId: '222523234712',
  appId: '1:222523234712:web:b508d345729d98ad4133ed',
  measurementId: 'G-0RKJVBCC8K'
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const fns = getFunctions(app);

let analytics = null;
if (location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
  try { analytics = getAnalytics(app); } catch (_) {}
}

// Connect to local emulators when developing locally
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  try {
    connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, 'localhost', 8080);
    connectFunctionsEmulator(fns, 'localhost', 5001);
  } catch (_) {}
}

export { app, analytics, auth, db, fns };

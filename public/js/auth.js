
function getLangPrefix() {
  return window.location.pathname.startsWith('/he/') ? '/he' : '';
}
// auth.js – shared auth utilities imported by every page
import { registerPlugin } from 'https://esm.sh/@capacitor/core@6.0.0';
import { auth, db, fns } from './firebase-config.js';
import {
  onAuthStateChanged,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithCredential
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import {
  doc, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import { httpsCallable } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-functions.js';

async function triggerWelcomeEmail() {
  try {
    await httpsCallable(fns, 'sendWelcomeEmail')({});
  } catch (_) {}
}

// Pages that require authentication
const PROTECTED = ['/dashboard.html', '/analysis.html', '/settings.html'];
// Pages that should redirect away when already logged in
const AUTH_ONLY  = ['/login.html'];

export function initAuthGuard(onUser) {
  onAuthStateChanged(auth, async (user) => {
    const path = location.pathname;

    if (!user) {
      if (PROTECTED.some(p => path.endsWith(p))) {
        sessionStorage.setItem('returnUrl', location.href);
        location.href = getLangPrefix() + '/login.html';
      }
    } else {
      if (AUTH_ONLY.some(p => path.endsWith(p))) {
        const ret = sessionStorage.getItem('returnUrl');
        sessionStorage.removeItem('returnUrl');
        location.href = ret || (getLangPrefix() + '/dashboard.html');
      }
    }

    if (onUser) onUser(user);
  });
}

export async function ensureUserProfile(user) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      email: user.email || '',
      displayName: user.displayName || '',
      subscriptionStatus: 'free',
      subscriptionId: null,
      subscriptionExpiry: null,
      monthlyUsage: 0,
      monthlyUsageReset: '',
      createdAt: new Date()
    });
    // New user — send welcome email
    triggerWelcomeEmail();
  }
  return (await getDoc(ref)).data();
}

export async function getUserData(uid) {
  const snap = await getDoc(doc(db, 'users', uid));
  return snap.exists() ? snap.data() : null;
}

export function isPro(userData) {
  if (!userData) return false;
  if (!['pro_monthly', 'pro_yearly'].includes(userData.subscriptionStatus)) return false;
  if (!userData.subscriptionExpiry) return true;
  return userData.subscriptionExpiry.toDate() > new Date();
}

export async function logout() {
  await signOut(auth);
  location.href = getLangPrefix() + '/login.html';
}

export async function signInWithGoogle() {
  // Use registerPlugin from esm.sh to dynamically register the plugin
  // without relying on window.Capacitor.registerPlugin
  const FirebaseAuthPlugin = (window.Capacitor && window.Capacitor.isNative) 
      ? registerPlugin('FirebaseAuthentication') 
      : null;

  if (window.Capacitor && window.Capacitor.isNative && FirebaseAuthPlugin) {
    try {
      // Native Google Sign-In via Capacitor Plugin
      const result = await FirebaseAuthPlugin.signInWithGoogle();
      if (!result.credential || !result.credential.idToken) {
          throw new Error('No idToken returned from Native Google Sign-In: ' + JSON.stringify(result));
      }
      const credential = GoogleAuthProvider.credential(result.credential.idToken);
      const webResult = await signInWithCredential(auth, credential);
      await ensureUserProfile(webResult.user);
      return webResult.user;
    } catch (err) {
      alert("NATIVE AUTH ERROR: " + err.message + " | " + JSON.stringify(err));
      throw err;
    }
  } else {
    // Standard Web Google Sign-In
    const provider = new GoogleAuthProvider();
    const result = await signInWithPopup(auth, provider);
    await ensureUserProfile(result.user);
    return result.user;
  }
}

export async function signUpWithEmail(email, password, name) {
  const cred = await createUserWithEmailAndPassword(auth, email, password);
  const user = cred.user;
  await setDoc(doc(db, 'users', user.uid), {
    email,
    displayName: name || '',
    subscriptionStatus: 'free',
    subscriptionId: null,
    subscriptionExpiry: null,
    monthlyUsage: 0,
    monthlyUsageReset: '',
    createdAt: new Date()
  });
  // New user — send welcome email
  triggerWelcomeEmail();
  return user;
}

export async function signInWithEmail(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  await ensureUserProfile(cred.user);
  return cred.user;
}

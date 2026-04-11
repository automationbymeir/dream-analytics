// auth.js – shared auth utilities imported by every page
import { auth, db } from './firebase-config.js';
import {
  onAuthStateChanged,
  signOut,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';
import {
  doc, getDoc, setDoc
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';

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
        location.href = '/login.html';
      }
    } else {
      if (AUTH_ONLY.some(p => path.endsWith(p))) {
        const ret = sessionStorage.getItem('returnUrl');
        sessionStorage.removeItem('returnUrl');
        location.href = ret || '/dashboard.html';
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
  location.href = '/login.html';
}

export async function signInWithGoogle() {
  const provider = new GoogleAuthProvider();
  const result = await signInWithPopup(auth, provider);
  await ensureUserProfile(result.user);
  return result.user;
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
  return user;
}

export async function signInWithEmail(email, password) {
  const cred = await signInWithEmailAndPassword(auth, email, password);
  await ensureUserProfile(cred.user);
  return cred.user;
}

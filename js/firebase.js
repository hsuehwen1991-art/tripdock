import { initializeApp } from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-app.js';
import {
  getAuth,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  sendPasswordResetEmail,
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider,
  onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-auth.js';
import {
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager,
  doc,
  getDoc,
  getDocs,
  setDoc,
  addDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  writeBatch,
  serverTimestamp
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-firestore.js';
import {
  getMessaging,
  getToken,
  isSupported as isMessagingSupported
} from 'https://www.gstatic.com/firebasejs/11.6.0/firebase-messaging.js';

const cfg = window.TRIPDOCK_CONFIG || {};
export const isConfigured = Boolean(
  cfg.firebase && cfg.firebase.apiKey && cfg.firebase.apiKey !== 'YOUR_API_KEY'
);

let app = null;
let auth = null;
let db = null;

if (isConfigured) {
  app = initializeApp(cfg.firebase);
  auth = getAuth(app);
  db = initializeFirestore(app, {
    localCache: persistentLocalCache({
      tabManager: persistentMultipleTabManager()
    })
  });
}

export async function getMessagingInstance() {
  if (!app) return null;
  try {
    const supported = await isMessagingSupported();
    return supported ? getMessaging(app) : null;
  } catch {
    return null;
  }
}

export {
  app, auth, db, cfg,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut,
  sendPasswordResetEmail, updatePassword, reauthenticateWithCredential,
  EmailAuthProvider, onAuthStateChanged,
  doc, getDoc, getDocs, setDoc, addDoc, updateDoc, deleteDoc,
  collection, query, where, orderBy, limit, onSnapshot, writeBatch, serverTimestamp,
  getToken
};

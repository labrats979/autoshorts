import { initializeApp, type FirebaseApp } from "firebase/app";
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";

// Firebase is optional: the app stays fully local-first when these are unset.
const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
};

export const firebaseEnabled = Boolean(config.apiKey && config.projectId && config.appId);

let app: FirebaseApp | null = null;
let auth: Auth | null = null;
let db: Firestore | null = null;

if (firebaseEnabled) {
  app = initializeApp(config);
  auth = getAuth(app);
  db = getFirestore(app);
}

export function firebaseAuth(): Auth {
  if (!auth) throw new Error("Firebase is not configured. Set the VITE_FIREBASE_* variables in .env.");
  return auth;
}

/** uid of the signed-in user, or null when Firebase is off or nobody is signed in. */
export function currentUid(): string | null {
  return auth?.currentUser?.uid ?? null;
}

export function firestore(): Firestore {
  if (!db) throw new Error("Firebase is not configured. Set the VITE_FIREBASE_* variables in .env.");
  return db;
}

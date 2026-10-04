import { invoke } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { Clerk } from "@clerk/clerk-js";
import { initClerk } from "tauri-plugin-clerk";
import { signInWithCustomToken } from "firebase/auth";
import { firebaseAuth } from "./firebase";

// Clerk owns sign-in; Firebase only holds a session minted from it so Firestore rules
// can check request.auth.uid (== the Clerk user id). The exchange happens on the
// Vercel function in web/api/firebase-token.ts.

const authApiUrl = import.meta.env.VITE_AUTH_API_URL?.replace(/\/+$/, "");

// Matches the app's dark theme (see :root in styles.css).
const appearance = {
  variables: {
    colorPrimary: "#8ee6c7",
    colorPrimaryForeground: "#0b0c10",
    colorBackground: "#1a1d24",
    colorForeground: "#f3f4f6",
    colorMutedForeground: "#a0aec0",
    colorNeutral: "#f3f4f6",
    colorInput: "#08090d",
    colorInputForeground: "#f3f4f6",
    fontFamily: "'Plus Jakarta Sans', ui-sans-serif, system-ui, sans-serif",
    borderRadius: "8px",
  },
};

let clerkPromise: Promise<Clerk | null> | null = null;

/** Resolves to null when no CLERK_PUBLISHABLE_KEY is configured. */
export function loadClerk(): Promise<Clerk | null> {
  clerkPromise ??= invoke<boolean>("clerk_enabled")
    .then((enabled) => (enabled ? initClerk({ appearance }) : null))
    .catch((err) => {
      clerkPromise = null;
      throw err;
    });
  return clerkPromise;
}

/** Trade the current Clerk session for a Firebase session with the same uid. */
export async function signInToFirebase(clerk: Clerk): Promise<void> {
  if (!authApiUrl) {
    throw new Error("Set VITE_AUTH_API_URL in .env to your Vercel deployment URL.");
  }
  const sessionToken = await clerk.session?.getToken();
  if (!sessionToken) throw new Error("No active Clerk session.");

  const response = await tauriFetch(`${authApiUrl}/api/firebase-token`, {
    method: "POST",
    headers: { Authorization: `Bearer ${sessionToken}` },
  });
  const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
  if (!response.ok || !body.token) {
    throw new Error(body.error ?? `Sign-in service returned ${response.status}.`);
  }
  await signInWithCustomToken(firebaseAuth(), body.token);
}

import React, { useEffect, useRef, useState } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
  type User,
} from "firebase/auth";
import { Cloud, CloudOff, DownloadCloud, Loader2, LogOut, RefreshCw } from "lucide-react";
import { firebaseAuth, firebaseEnabled } from "./firebase";
import { restoreProject, syncAll, type CloudProjectDoc, type SyncedProject } from "./cloudSync";

type Props = {
  projects: SyncedProject[];
  /** Changes whenever local data that should be synced changes. */
  syncKey: string;
  onRestored: (projectId: string) => void;
};

const SYNC_DEBOUNCE_MS = 1500;

export function CloudSyncPanel({ projects, syncKey, onRestored }: Props) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!firebaseEnabled);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authBusy, setAuthBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [remoteOnly, setRemoteOnly] = useState<CloudProjectDoc[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const runningRef = useRef(false);
  const rerunRef = useRef(false);

  useEffect(() => {
    if (!firebaseEnabled) return;
    return onAuthStateChanged(firebaseAuth(), (nextUser) => {
      setUser(nextUser);
      setAuthReady(true);
      if (!nextUser) {
        setRemoteOnly([]);
        setLastSynced(null);
      }
    });
  }, []);

  async function runSync(uid: string) {
    if (runningRef.current) {
      rerunRef.current = true;
      return;
    }
    runningRef.current = true;
    setSyncing(true);
    setError(null);
    try {
      do {
        rerunRef.current = false;
        const summary = await syncAll(uid, projectsRef.current);
        setRemoteOnly(summary.remoteOnly);
        setLastSynced(new Date());
      } while (rerunRef.current);
    } catch (err) {
      setError(describe(err));
    } finally {
      runningRef.current = false;
      setSyncing(false);
    }
  }

  useEffect(() => {
    if (!user) return;
    const timer = window.setTimeout(() => void runSync(user.uid), SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [user, syncKey]);

  async function authenticate(mode: "signIn" | "signUp", event?: React.FormEvent) {
    event?.preventDefault();
    setAuthBusy(true);
    setError(null);
    setMessage(null);
    try {
      const auth = firebaseAuth();
      if (mode === "signIn") {
        await signInWithEmailAndPassword(auth, email.trim(), password);
      } else {
        await createUserWithEmailAndPassword(auth, email.trim(), password);
      }
      setPassword("");
    } catch (err) {
      setError(describe(err));
    } finally {
      setAuthBusy(false);
    }
  }

  async function resetPassword() {
    if (!email.trim()) {
      setError("Enter your email first.");
      return;
    }
    setError(null);
    try {
      await sendPasswordResetEmail(firebaseAuth(), email.trim());
      setMessage("Password reset email sent.");
    } catch (err) {
      setError(describe(err));
    }
  }

  async function restore(projectId: string) {
    if (!user) return;
    setRestoringId(projectId);
    setError(null);
    try {
      await restoreProject(user.uid, projectId);
      setRemoteOnly((current) => current.filter((doc) => doc.project.id !== projectId));
      onRestored(projectId);
    } catch (err) {
      setError(describe(err));
    } finally {
      setRestoringId(null);
    }
  }

  if (!firebaseEnabled) {
    return (
      <section className="cloud-panel" aria-label="Cloud sync">
        <div className="cloud-panel-header muted">
          <CloudOff size={14} />
          <span>Cloud sync off</span>
        </div>
        <p className="cloud-hint">Add VITE_FIREBASE_* keys to .env to enable Firebase sync.</p>
      </section>
    );
  }

  if (!authReady) {
    return (
      <section className="cloud-panel" aria-label="Cloud sync">
        <div className="cloud-panel-header muted">
          <Loader2 className="spin" size={14} />
          <span>Connecting…</span>
        </div>
      </section>
    );
  }

  if (!user) {
    return (
      <section className="cloud-panel" aria-label="Cloud sync">
        <div className="cloud-panel-header">
          <Cloud size={14} />
          <span>Sign in to back up projects</span>
        </div>
        <form className="cloud-form" onSubmit={(event) => void authenticate("signIn", event)}>
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            minLength={6}
            required
          />
          <div className="cloud-form-actions">
            <button type="submit" className="cloud-button primary" disabled={authBusy}>
              {authBusy ? <Loader2 className="spin" size={13} /> : null}
              Sign in
            </button>
            <button
              type="button"
              className="cloud-button"
              disabled={authBusy}
              onClick={() => void authenticate("signUp")}
            >
              Create account
            </button>
          </div>
          <button type="button" className="cloud-link" onClick={() => void resetPassword()}>
            Forgot password?
          </button>
        </form>
        {message && <p className="cloud-hint">{message}</p>}
        {error && <p className="cloud-error">{error}</p>}
      </section>
    );
  }

  return (
    <section className="cloud-panel" aria-label="Cloud sync">
      <div className="cloud-panel-header">
        {syncing ? <Loader2 className="spin" size={14} /> : <Cloud size={14} />}
        <span title={user.email ?? undefined}>{user.email}</span>
        <button className="cloud-icon" title="Sync now" disabled={syncing} onClick={() => void runSync(user.uid)}>
          <RefreshCw size={13} />
        </button>
        <button className="cloud-icon" title="Sign out" onClick={() => void signOut(firebaseAuth())}>
          <LogOut size={13} />
        </button>
      </div>
      <p className="cloud-hint">
        {syncing
          ? "Syncing…"
          : lastSynced
            ? `Synced ${lastSynced.toLocaleTimeString()}`
            : "Waiting to sync"}
      </p>

      {remoteOnly.length > 0 && (
        <div className="cloud-remote-list">
          <p className="cloud-hint">In the cloud, not on this device:</p>
          {remoteOnly.map((doc) => (
            <button
              key={doc.project.id}
              className="project-row"
              disabled={restoringId !== null}
              onClick={() => void restore(doc.project.id)}
              title={`Restore to this device. Source media: ${doc.project.sourcePath}`}
            >
              {restoringId === doc.project.id ? <Loader2 className="spin" size={15} /> : <DownloadCloud size={15} />}
              <span>{doc.project.name || fileName(doc.project.sourcePath)}</span>
              <span />
            </button>
          ))}
        </div>
      )}

      {error && <p className="cloud-error">{error}</p>}
    </section>
  );
}

function fileName(path: string) {
  return path.split(/[\\/]/).pop() || path;
}

function describe(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  // Firebase errors look like "Firebase: Error (auth/wrong-password)."
  const code = raw.match(/\(([a-z-]+\/[a-z-]+)\)/)?.[1];
  switch (code) {
    case "auth/invalid-credential":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "Incorrect email or password.";
    case "auth/email-already-in-use":
      return "An account with this email already exists. Sign in instead.";
    case "auth/weak-password":
      return "Password must be at least 6 characters.";
    case "auth/invalid-email":
      return "That email address is not valid.";
    case "auth/network-request-failed":
      return "Network error. Check your connection.";
    case "auth/operation-not-allowed":
      return "Email/password sign-in is disabled in the Firebase console.";
    default:
      return raw;
  }
}

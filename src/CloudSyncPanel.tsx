import { useEffect, useRef, useState } from "react";
import type { Clerk } from "@clerk/clerk-js";
import { onAuthStateChanged, signOut, type User } from "firebase/auth";
import { Cloud, CloudOff, DownloadCloud, Loader2, LogIn, RefreshCw, UserPlus } from "lucide-react";
import { firebaseAuth, firebaseEnabled } from "./firebase";
import { loadClerk, signInToFirebase } from "./clerkAuth";
import { restoreProject, syncAll, type CloudProjectDoc, type SyncedProject } from "./cloudSync";

type Props = {
  projects: SyncedProject[];
  /** Changes whenever local data that should be synced changes. */
  syncKey: string;
  onRestored: (projectId: string) => void;
};

type ClerkUser = NonNullable<Clerk["user"]>;

const SYNC_DEBOUNCE_MS = 1500;

export function CloudSyncPanel({ projects, syncKey, onRestored }: Props) {
  const [clerk, setClerk] = useState<Clerk | null>(null);
  const [clerkState, setClerkState] = useState<"loading" | "disabled" | "ready" | "error">(
    firebaseEnabled ? "loading" : "disabled",
  );
  const [clerkUser, setClerkUser] = useState<ClerkUser | null>(null);
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [linking, setLinking] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [lastSynced, setLastSynced] = useState<Date | null>(null);
  const [remoteOnly, setRemoteOnly] = useState<CloudProjectDoc[]>([]);
  const [restoringId, setRestoringId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const userButtonRef = useRef<HTMLDivElement>(null);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;
  const runningRef = useRef(false);
  const rerunRef = useRef(false);
  const linkingRef = useRef(false);

  useEffect(() => {
    if (!firebaseEnabled) return;
    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    loadClerk()
      .then((instance) => {
        if (cancelled) return;
        if (!instance) {
          setClerkState("disabled");
          return;
        }
        setClerk(instance);
        setClerkUser(instance.user ?? null);
        setClerkState("ready");
        unsubscribe = instance.addListener(({ user }) => setClerkUser(user ?? null));
      })
      .catch((err) => {
        if (cancelled) return;
        setClerkState("error");
        setError(describe(err));
      });

    const unsubscribeFirebase = onAuthStateChanged(firebaseAuth(), (user) => {
      setFirebaseUser(user);
      if (!user) {
        setRemoteOnly([]);
        setLastSynced(null);
      }
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
      unsubscribeFirebase();
    };
  }, []);

  // Keep the Firebase session in step with Clerk: same uid when signed in, none when signed out.
  useEffect(() => {
    if (clerkState !== "ready" || !clerk) return;
    if (!clerkUser) {
      if (firebaseUser) void signOut(firebaseAuth());
      return;
    }
    if (firebaseUser?.uid !== clerkUser.id) linkFirebase(clerk);
  }, [clerk, clerkState, clerkUser, firebaseUser]);

  function linkFirebase(instance: Clerk) {
    if (linkingRef.current) return;
    linkingRef.current = true;
    setLinking(true);
    setError(null);
    signInToFirebase(instance)
      .catch((err) => setError(describe(err)))
      .finally(() => {
        linkingRef.current = false;
        setLinking(false);
      });
  }

  const syncUid = clerkUser && firebaseUser?.uid === clerkUser.id ? firebaseUser.uid : null;

  useEffect(() => {
    const node = userButtonRef.current;
    if (!clerk || !clerkUser || !node) return;
    clerk.mountUserButton(node);
    return () => clerk.unmountUserButton(node);
  }, [clerk, clerkUser]);

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
    if (!syncUid) return;
    const timer = window.setTimeout(() => void runSync(syncUid), SYNC_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [syncUid, syncKey]);

  async function restore(projectId: string) {
    if (!syncUid) return;
    setRestoringId(projectId);
    setError(null);
    try {
      await restoreProject(syncUid, projectId);
      setRemoteOnly((current) => current.filter((doc) => doc.project.id !== projectId));
      onRestored(projectId);
    } catch (err) {
      setError(describe(err));
    } finally {
      setRestoringId(null);
    }
  }

  function openClerk(mode: "signIn" | "signUp") {
    if (!clerk) return;
    setError(null);
    try {
      if (mode === "signIn") clerk.openSignIn();
      else clerk.openSignUp();
    } catch (err) {
      setError(`Clerk sign-in could not open: ${describe(err)}`);
    }
  }

  if (clerkState === "disabled") {
    return (
      <section className="cloud-panel" aria-label="Account">
        <div className="cloud-panel-header muted">
          <CloudOff size={14} />
          <span>Cloud sync off</span>
        </div>
        <p className="cloud-hint">
          {firebaseEnabled
            ? "Add CLERK_PUBLISHABLE_KEY to .env to enable sign-in."
            : "Add the Clerk and Firebase keys to .env to enable sign-in and sync."}
        </p>
      </section>
    );
  }

  if (clerkState === "loading") {
    return (
      <section className="cloud-panel" aria-label="Account">
        <div className="cloud-panel-header muted">
          <Loader2 className="spin" size={14} />
          <span>Connecting…</span>
        </div>
      </section>
    );
  }

  if (clerkState === "error" || !clerkUser) {
    return (
      <section className="cloud-panel" aria-label="Account">
        <div className="cloud-panel-header">
          <Cloud size={14} />
          <span>Sign in to sync projects</span>
        </div>
        <div className="cloud-form-actions">
          <button className="cloud-button primary" disabled={!clerk} onClick={() => openClerk("signIn")}>
            <LogIn size={13} />
            Sign in
          </button>
          <button className="cloud-button" disabled={!clerk} onClick={() => openClerk("signUp")}>
            <UserPlus size={13} />
            Sign up
          </button>
        </div>
        {error && <p className="cloud-error">{error}</p>}
      </section>
    );
  }

  const email = clerkUser.primaryEmailAddress?.emailAddress ?? clerkUser.username ?? "Signed in";

  return (
    <section className="cloud-panel" aria-label="Account">
      <div className="cloud-account">
        <div ref={userButtonRef} className="cloud-user-button" />
        <span title={email}>{email}</span>
        <button
          className="cloud-icon"
          title={syncUid ? "Sync now" : "Reconnect cloud sync"}
          disabled={syncing || linking}
          onClick={() => (syncUid ? void runSync(syncUid) : clerk && linkFirebase(clerk))}
        >
          {syncing || linking ? <Loader2 className="spin" size={13} /> : <RefreshCw size={13} />}
        </button>
      </div>
      <p className="cloud-hint">
        {linking
          ? "Connecting to cloud…"
          : !syncUid
            ? "Not connected to cloud sync"
            : syncing
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
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return JSON.stringify(err);
}

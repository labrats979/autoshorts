import { invoke } from "@tauri-apps/api/core";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  writeBatch,
} from "firebase/firestore";
import { firestore } from "./firebase";

// Firestore layout (all under the signed-in user's uid):
//   users/{uid}/projects/{projectId}                    project row, candidates, transcript metadata
//   users/{uid}/projects/{projectId}/transcriptChunks/{n} raw transcript JSON split to stay under 1 MiB/doc
// Rendered clip files stay on disk; only metadata is synced.

export type SyncedProject = {
  id: string;
  name: string | null;
  sourcePath: string;
  sourceDuration: number | null;
  status: string;
  transcriptionMode: string;
  captionStyle?: string | null;
  createdAt: string;
  updatedAt: string;
};

export type SyncedTranscript = {
  id: string;
  projectId: string;
  engine: string;
  rawJson: string;
  language: string | null;
  createdAt: string;
};

export type SyncedCandidate = {
  id: string;
  projectId: string;
  startSec: number;
  endSec: number;
  score: number;
  hook: string;
  rationale: string;
  rank: number;
  selected: boolean;
};

export type LocalProjectDetail = {
  project: SyncedProject;
  transcript: SyncedTranscript | null;
  candidates: SyncedCandidate[];
};

type TranscriptMeta = Omit<SyncedTranscript, "rawJson"> & { chunkCount: number };

export type CloudProjectDoc = {
  project: SyncedProject;
  candidates: SyncedCandidate[];
  transcript: TranscriptMeta | null;
  signature: string;
  syncedAt: string;
  deleted?: boolean;
  deletedAt?: string;
};

export type SyncSummary = { pushed: number; skipped: number; remoteOnly: CloudProjectDoc[] };

// JS chars are at most 3 UTF-8 bytes each (surrogate pairs are 4 bytes for 2 chars),
// so 250k chars stays well below Firestore's 1 MiB document limit.
const CHUNK_CHARS = 250_000;

function projectsCol(uid: string) {
  return collection(firestore(), "users", uid, "projects");
}

function projectRef(uid: string, projectId: string) {
  return doc(firestore(), "users", uid, "projects", projectId);
}

function chunksCol(uid: string, projectId: string) {
  return collection(firestore(), "users", uid, "projects", projectId, "transcriptChunks");
}

function signatureOf(detail: LocalProjectDetail): string {
  return JSON.stringify([detail.project, detail.transcript?.id ?? null, detail.candidates]);
}

// Firestore rejects `undefined` field values.
function clean<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function deleteChunks(uid: string, projectId: string, fromIndex = 0) {
  const snapshot = await getDocs(chunksCol(uid, projectId));
  const stale = snapshot.docs.filter((chunk) => Number(chunk.id) >= fromIndex);
  for (let i = 0; i < stale.length; i += 400) {
    const batch = writeBatch(firestore());
    stale.slice(i, i + 400).forEach((chunk) => batch.delete(chunk.ref));
    await batch.commit();
  }
}

async function pushProject(uid: string, detail: LocalProjectDetail, existing: CloudProjectDoc | undefined) {
  const { transcript } = detail;
  let transcriptMeta: TranscriptMeta | null = null;

  if (transcript) {
    const chunkCount = Math.max(1, Math.ceil(transcript.rawJson.length / CHUNK_CHARS));
    const { rawJson, ...meta } = transcript;
    transcriptMeta = { ...meta, chunkCount };

    // Only re-upload the (potentially large) transcript when it actually changed.
    if (existing?.transcript?.id !== transcript.id) {
      for (let index = 0; index < chunkCount; index++) {
        const data = rawJson.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS);
        await setDoc(doc(chunksCol(uid, detail.project.id), String(index)), { data });
      }
      await deleteChunks(uid, detail.project.id, chunkCount);
    }
  } else if (existing?.transcript) {
    await deleteChunks(uid, detail.project.id);
  }

  const payload: CloudProjectDoc = {
    project: detail.project,
    candidates: detail.candidates,
    transcript: transcriptMeta,
    signature: signatureOf(detail),
    syncedAt: new Date().toISOString(),
  };
  await setDoc(projectRef(uid, detail.project.id), clean(payload));
}

/** Push every local project whose content differs from its cloud copy. */
export async function syncAll(uid: string, localProjects: SyncedProject[]): Promise<SyncSummary> {
  const snapshot = await getDocs(projectsCol(uid));
  const cloud = new Map(snapshot.docs.map((d) => [d.id, d.data() as CloudProjectDoc]));
  const localIds = new Set(localProjects.map((p) => p.id));

  let pushed = 0;
  let skipped = 0;
  for (const project of localProjects) {
    const existing = cloud.get(project.id);
    // Deleted on another device after this copy was last touched: don't resurrect it.
    if (existing?.deleted && existing.deletedAt && Date.parse(project.updatedAt) <= Date.parse(existing.deletedAt)) {
      skipped++;
      continue;
    }
    const detail = await invoke<LocalProjectDetail>("get_project_detail", { projectId: project.id });
    if (existing && !existing.deleted && existing.signature === signatureOf(detail)) {
      skipped++;
      continue;
    }
    await pushProject(uid, detail, existing?.deleted ? undefined : existing);
    pushed++;
  }

  const remoteOnly = [...cloud.entries()]
    .filter(([id, data]) => !localIds.has(id) && !data.deleted)
    .map(([, data]) => data);

  return { pushed, skipped, remoteOnly };
}

/** Download a cloud project (with its transcript) into the local SQLite database. */
export async function restoreProject(uid: string, projectId: string): Promise<void> {
  const snapshot = await getDoc(projectRef(uid, projectId));
  if (!snapshot.exists()) throw new Error("This project no longer exists in the cloud.");
  const data = snapshot.data() as CloudProjectDoc;

  let transcript: SyncedTranscript | null = null;
  if (data.transcript) {
    const chunks = await getDocs(chunksCol(uid, projectId));
    const ordered = chunks.docs
      .filter((chunk) => Number(chunk.id) < data.transcript!.chunkCount)
      .sort((a, b) => Number(a.id) - Number(b.id));
    if (ordered.length !== data.transcript.chunkCount) {
      throw new Error("The cloud transcript is incomplete. Sync again from the original device.");
    }
    const { chunkCount: _chunkCount, ...meta } = data.transcript;
    transcript = { ...meta, rawJson: ordered.map((chunk) => chunk.data().data as string).join("") };
  }

  await invoke("import_synced_project", {
    project: data.project,
    transcript,
    candidates: data.candidates ?? [],
  });
}

/** Mark a project deleted in the cloud so other devices stop syncing it. */
export async function deleteCloudProject(uid: string, projectId: string): Promise<void> {
  await deleteChunks(uid, projectId);
  await setDoc(projectRef(uid, projectId), {
    deleted: true,
    deletedAt: new Date().toISOString(),
  });
}


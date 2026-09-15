import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, resolve } from "node:path";
import { AgentError } from "./errors.js";
import { projectById, verifyProjectIdentity } from "./projects.js";
import type { StateStore } from "./store.js";
import { isPathInside } from "./util.js";

export const MAX_PROJECT_FILE_BYTES = 50 * 1024 * 1024;
export const PROJECT_FILE_CHUNK_BYTES = 192 * 1024;

export interface ProjectFileRequest {
  logicalSessionId: string;
  projectId: string;
  path: string;
}

export interface ProjectFileMetadata {
  filename: string;
  size: number;
}

/** Read one regular file through its already-authorized Session and Project binding. */
export async function streamProjectFile(
  store: StateStore,
  request: ProjectFileRequest,
  callbacks: {
    signal: AbortSignal;
    onStart(metadata: ProjectFileMetadata): void | Promise<void>;
    onChunk(chunk: Buffer, sequence: number): void | Promise<void>;
  },
): Promise<{ sha256: string; size: number; chunks: number }> {
  const state = store.snapshot();
  const thread = Object.values(state.managedThreads).find(
    (candidate) => candidate.logicalSessionId === request.logicalSessionId,
  );
  if (!thread || thread.projectId !== request.projectId) {
    throw new AgentError("FILE_SESSION_BINDING_INVALID", "File does not belong to this Session and Project");
  }
  const project = projectById(store, request.projectId);
  await verifyProjectIdentity(project);
  const requested = isAbsolute(request.path) ? request.path : resolve(thread.sessionCwd ?? project.root, request.path);
  const canonical = await realpath(requested).catch(() => {
    throw new AgentError("FILE_NOT_FOUND", "File was not found on the host");
  });
  if (!isPathInside(project.root, canonical)) {
    throw new AgentError("FILE_OUTSIDE_PROJECT", "File is outside the Session Project");
  }

  const handle = await open(canonical, "r").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") throw new AgentError("FILE_NOT_FOUND", "File was not found on the host");
    if (error.code === "EACCES" || error.code === "EPERM") throw new AgentError("FILE_ACCESS_DENIED", "File cannot be read by the Agent account");
    throw error;
  });
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new AgentError("FILE_NOT_REGULAR", "Only regular files can be previewed or downloaded");
    if (before.size > MAX_PROJECT_FILE_BYTES) throw new AgentError("FILE_TOO_LARGE", "File exceeds the 50 MB transfer limit");
    await callbacks.onStart({ filename: basename(canonical), size: before.size });
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(PROJECT_FILE_CHUNK_BYTES);
    let position = 0;
    let sequence = 0;
    while (position < before.size) {
      if (callbacks.signal.aborted) throw new AgentError("FILE_TRANSFER_CANCELLED", "File transfer was cancelled");
      const length = Math.min(buffer.length, before.size - position);
      const { bytesRead } = await handle.read(buffer, 0, length, position);
      if (bytesRead === 0) throw new AgentError("FILE_CHANGED", "File changed while it was being read");
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      hash.update(chunk);
      await callbacks.onChunk(chunk, sequence);
      position += bytesRead;
      sequence += 1;
    }
    const after = await handle.stat();
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || after.dev !== before.dev || after.ino !== before.ino) {
      throw new AgentError("FILE_CHANGED", "File changed while it was being read");
    }
    return { sha256: hash.digest("hex"), size: position, chunks: sequence };
  } finally {
    await handle.close();
  }
}

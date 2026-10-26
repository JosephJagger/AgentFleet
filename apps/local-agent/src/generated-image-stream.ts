import { createHash } from "node:crypto";
import { AgentError } from "./errors.js";
import { openGeneratedArtifact } from "./generated-images.js";
import type { StateStore } from "./store.js";
import { PROJECT_FILE_CHUNK_BYTES, type ProjectFileMetadata } from "./project-files.js";

export interface GeneratedImageRequest { logicalSessionId: string; projectId: string; nativeThreadId: string; itemId: string }
export async function streamGeneratedImage(store: StateStore, request: GeneratedImageRequest, callbacks: {
  signal: AbortSignal; onStart(metadata: ProjectFileMetadata): void | Promise<void>;
  onChunk(chunk: Buffer, sequence: number): void | Promise<void>;
}, environment: NodeJS.ProcessEnv = process.env) {
  const checkBinding = () => {
    const state = store.snapshot();
    const binding = state.nativeThreadBindings[request.nativeThreadId];
    const thread = Object.values(state.managedThreads).find(t => t.nativeThreadId === request.nativeThreadId && t.logicalSessionId === request.logicalSessionId);
    if (!(binding?.logicalSessionId === request.logicalSessionId && binding.projectId === request.projectId || thread?.projectId === request.projectId)
      || state.projectContentPolicies[request.projectId]?.syncContent === false || state.nativeDeletionTombstones[request.nativeThreadId])
      throw new AgentError("FILE_SESSION_BINDING_INVALID", "Generated image is not available for this Session");
  };
  checkBinding();
  const artifact = await openGeneratedArtifact(request.nativeThreadId, request.itemId, environment).catch(() => {
    throw new AgentError("FILE_NOT_FOUND", "Generated image is unavailable on the host");
  });
  try {
    await callbacks.onStart({ filename: `generated-image.${artifact.mime === "jpeg" ? "jpg" : artifact.mime}`, size: artifact.size });
    const hash = createHash("sha256"), buffer = Buffer.alloc(PROJECT_FILE_CHUNK_BYTES);
    let position = 0, sequence = 0;
    while (position < artifact.size) {
      callbacks.signal.throwIfAborted(); checkBinding();
      const { bytesRead } = await artifact.file.read(buffer,0,Math.min(buffer.length,artifact.size-position),position);
      if (!bytesRead) throw new AgentError("FILE_CHANGED", "Generated image changed during transfer");
      const chunk = buffer.subarray(0,bytesRead); hash.update(chunk);
      await callbacks.onChunk(chunk,sequence++); position += bytesRead;
    }
    await artifact.verify();
    return {sha256:hash.digest("hex"),size:position,chunks:sequence};
  } finally { await artifact.file.close(); }
}

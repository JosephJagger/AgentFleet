import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { MAX_GENERATED_IMAGE_BYTES, validGeneratedImageUrl } from "./images.js";

/** Keep native paths, file IDs and provider failures on the host. */
export function generatedImageItem(value: Record<string, unknown>): Record<string, unknown> {
  const status = value.status === "completed" ? "completed" : value.status === "failed" ? "failed" : "in_progress";
  const url = typeof value.fileId === "string" ? undefined : imageDataUrl(value.result);
  return { type: "imageGeneration", id: value.id, status,
    imageState: status === "completed" ? url ? "ready" : "unavailable" : status,
    content: status === "completed" && url ? [{ type: "image", url }] : [] };
}

function imageDataUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > Math.ceil(MAX_GENERATED_IMAGE_BYTES / 3) * 4 + 32) return;
  if (validGeneratedImageUrl(value)) return value;
  // Native result is raw base64. MIME comes from the bytes, never a path suffix.
  for (const mime of ["png", "jpeg", "webp"]) {
    const url = `data:image/${mime};base64,${value}`;
    if (validGeneratedImageUrl(url)) return url;
  }
  return;
}

/** 0.164.0 app-server saves generated_images/<thread>/<call>.png under CODEX_HOME
 * before emitting a fileId item. There is no public fileId resolver RPC. Read
 * only that exact native artifact, never an arbitrary savedPath or remote URL.
 */
export async function resolveGeneratedImage(value: Record<string, unknown>, threadId: string, environment: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const item = generatedImageItem(value);
  if (item.imageState !== "unavailable" || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(threadId) || value.id.length > 256) return item;
  const home = resolve(environment.CODEX_HOME || join(environment.HOME || environment.USERPROFILE || homedir(), ".codex"));
  const name = value.id.replace(/[^A-Za-z0-9_-]/g, "_") || "generated_image";
  const expected = join(home, "generated_images", threadId, `${name}.png`);
  if (value.savedPath != null && (typeof value.savedPath !== "string" || resolve(value.savedPath) !== expected)) return item;
  try {
    const root = await realpath(home);
    const path = join(root, "generated_images", threadId, `${name}.png`);
    if (await realpath(expected) !== path) return item;
    for (const parent of [join(root, "generated_images"), join(root, "generated_images", threadId)]) {
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink()) return item;
    }
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > MAX_GENERATED_IMAGE_BYTES) return item;
      const buffer = Buffer.alloc(before.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      const after = await file.stat();
      const current = await lstat(path);
      if (offset !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || current.ino !== before.ino || current.dev !== before.dev || await realpath(expected) !== path) return item;
      const url = imageDataUrl(buffer.subarray(0, offset).toString("base64"));
      if (url) return { ...item, imageState: "ready", content: [{ type: "image", url }] };
    } finally { await file.close(); }
  } catch { /* Missing/unsafe native artifacts are visible as unavailable, never fatal to a turn. */ }
  return item;
}

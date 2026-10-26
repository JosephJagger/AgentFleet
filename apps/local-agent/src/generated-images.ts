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

/** Open only the exact native artifact; never follow caller-provided paths. */
export async function openGeneratedArtifact(threadId: string, itemId: string, environment: NodeJS.ProcessEnv = process.env, savedPath?: unknown) {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(threadId) || !itemId || itemId.length > 256) throw new Error("Invalid generated image identity");
  const home = resolve(environment.CODEX_HOME || join(environment.HOME || environment.USERPROFILE || homedir(), ".codex"));
  const name = itemId.replace(/[^A-Za-z0-9_-]/g, "_");
  const expected = join(home, "generated_images", threadId, `${name}.png`);
  if (savedPath != null && (typeof savedPath !== "string" || resolve(savedPath) !== expected)) throw new Error("Mismatched generated image path");
  const root = await realpath(home);
  const path = join(root, "generated_images", threadId, `${name}.png`);
  if (await realpath(expected) !== path) throw new Error("Redirected generated image");
  for (const parent of [join(root, "generated_images"), join(root, "generated_images", threadId)]) {
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Redirected generated image directory");
  }
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size < 1 || !Number.isSafeInteger(before.size)) throw new Error("Invalid generated image file");
    const header = Buffer.alloc(24);
    await file.read(header, 0, header.length, 0);
    const mime = header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "png"
      : header[0] === 255 && header[1] === 216 && header[2] === 255 ? "jpeg"
      : header.toString("ascii",0,4) === "RIFF" && header.toString("ascii",8,12) === "WEBP" ? "webp" : undefined;
    if (!mime) throw new Error("Unsupported generated image format");
    const verify = async () => {
      const after = await file.stat(), current = await lstat(path);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.ino !== before.ino || current.dev !== before.dev || current.nlink !== 1 || await realpath(expected) !== path) throw new Error("Generated image changed");
    };
    await verify();
    return { file, size: before.size, mime, verify };
  } catch (error) { await file.close(); throw error; }
}

/** Small images are cached for offline viewing. Larger originals are streamed on demand. */
export async function resolveGeneratedImage(value: Record<string, unknown>, threadId: string, environment: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  const item = generatedImageItem(value);
  if (item.imageState !== "unavailable" || typeof value.id !== "string") return item;
  try {
    const artifact = await openGeneratedArtifact(threadId, value.id, environment, value.savedPath);
    try {
      if (artifact.size > MAX_GENERATED_IMAGE_BYTES) return { ...item, imageState: "streamed", imageBytes: artifact.size, imageMime: artifact.mime };
      const buffer = Buffer.alloc(artifact.size + 1);
      let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await artifact.file.read(buffer, offset, buffer.length - offset, offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      await artifact.verify();
      if (offset !== artifact.size) return item;
      const url = imageDataUrl(buffer.subarray(0,offset).toString("base64"));
      if (url) return { ...item, imageState: "ready", content: [{ type: "image", url }] };
    } finally { await artifact.file.close(); }
  } catch { /* Missing/unsafe artifacts never prevent reconciliation. */ }
  return item;
}

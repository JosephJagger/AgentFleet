/** Strict same-origin URLs for display only; never accepted as image inputs for a task. */
export const isStoredEventImage = (value: unknown): value is string => typeof value === "string"
  && /^\/api\/sessions\/[A-Za-z0-9_-]{1,256}\/images\/[A-Za-z0-9_-]{1,200}\/[a-f0-9]{64}$/.test(value);
export const isStreamedGeneratedImage = (value: unknown): value is string => typeof value === "string"
  && /^\/api\/sessions\/[A-Za-z0-9_-]{1,256}\/files\?generatedEvent=[A-Za-z0-9_-]{1,200}$/.test(value);
/** Small images may be cached inline; large originals use an authenticated stream. */
export const isGeneratedImage = (value: unknown): value is string => isStoredEventImage(value) || isStreamedGeneratedImage(value) || typeof value === "string"
  && value.length <= Math.ceil(8 * 1024 * 1024 / 3) * 4 + 32
  && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);

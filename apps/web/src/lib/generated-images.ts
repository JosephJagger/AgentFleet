/** Output images have their own size bound; pasted input limits stay unchanged. */
export const isGeneratedImage = (value: unknown): value is string => typeof value === "string"
  && value.length <= Math.ceil(8 * 1024 * 1024 / 3) * 4 + 32
  && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(value);

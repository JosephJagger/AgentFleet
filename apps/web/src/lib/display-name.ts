import { theme } from "./theme";

/** Presentation only. Never use this result as an identifier, stored alias or API argument. */
export function maskPrivateName(value: string): string {
  return value.replace(/cupshe|gongqiankun|caguuu/gi, match => `${match[0].toLowerCase()}****${match.at(-1)!.toLowerCase()}`);
}
export function displayName(value: string | null | undefined): string {
  const text = value ?? "";
  return theme() === "buzhoushan" ? maskPrivateName(text) : text;
}

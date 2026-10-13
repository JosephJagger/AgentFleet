/** Presentation only. Never use this result as an identifier or stored alias. Welcome speech may send it as transient display text. */
export function maskPrivateName(value: string): string {
  return value.replace(/cupshe|gongqiankun|caguuu/gi, match => `${match[0].toLowerCase()}****${match.at(-1)!.toLowerCase()}`);
}
export function displayName(value: string | null | undefined): string {
  const text = value ?? "";
  return maskPrivateName(text);
}

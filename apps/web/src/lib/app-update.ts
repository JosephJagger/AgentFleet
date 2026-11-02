/** Detects that the server now ships a different frontend build than the one running in this tab. */
const ENTRY_SCRIPT = /<script[^>]*type="module"[^>]*src="(\/assets\/[^"]+\.js)"/;

export function entryFromHtml(html: string): string | undefined {
  return ENTRY_SCRIPT.exec(html)?.[1];
}

export function runningEntry(doc: Document = document): string | undefined {
  return doc.querySelector<HTMLScriptElement>('script[type="module"][src^="/assets/"]')?.getAttribute("src") ?? undefined;
}

/** True only when both builds are known and differ. Network or parse failures never report an update. */
export async function newBuildAvailable(fetcher: typeof fetch = fetch, running = runningEntry()): Promise<boolean> {
  if (!running) return false;
  try {
    const response = await fetcher("/", { cache: "no-store", headers: { accept: "text/html" }, credentials: "same-origin" });
    if (!response.ok) return false;
    const latest = entryFromHtml(await response.text());
    return latest !== undefined && latest !== running;
  } catch {
    return false;
  }
}

/** Separate browser profile ensures launch switches apply even with an existing PWA open. */
export function windowsBroadcastLauncher(origin:string):string {
  const url=new URL(origin);
  if(!/^https?:$/.test(url.protocol)||url.username||url.password||!/^https?:\/\/[a-z0-9.:[\]-]+$/i.test(url.origin))throw new Error('Invalid broadcast origin');
  return [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'rem AgentFleets broadcast window. Uses an isolated Edge/Chrome profile.',
    'rem Sign in once. Select this window in Live Companion; keep it unminimized.',
    'set "AF_BROWSER="',
    'for %%B in ("%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe" "%ProgramFiles%\\Microsoft\\Edge\\Application\\msedge.exe" "%LOCALAPPDATA%\\Microsoft\\Edge\\Application\\msedge.exe" "%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe" "%ProgramFiles(x86)%\\Google\\Chrome\\Application\\chrome.exe" "%LOCALAPPDATA%\\Google\\Chrome\\Application\\chrome.exe") do if not defined AF_BROWSER if exist "%%~B" set "AF_BROWSER=%%~B"',
    'if not defined AF_BROWSER (',
    '  echo Microsoft Edge or Google Chrome was not found. Install one and retry.',
    '  pause',
    '  exit /b 1',
    ')',
    `start "" "%AF_BROWSER%" "--user-data-dir=%LOCALAPPDATA%\\AgentFleets\\BroadcastProfile" --no-first-run --no-default-browser-check --disable-backgrounding-occluded-windows --disable-background-timer-throttling --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion --window-size=1600,940 "--app=${url.origin}/workbench?broadcast=1"`,
    'endlocal',
    '',
  ].join('\r\n');
}

export function downloadBroadcastLauncher() {
  const url=URL.createObjectURL(new Blob([windowsBroadcastLauncher(location.origin)],{type:'application/octet-stream'}));
  const link=document.createElement('a');link.href=url;link.download='AgentFleets-Broadcast.cmd';document.body.append(link);link.click();link.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}

const broadcastWindowName='agentfleet-broadcast-canvas';
/** New user-requested window only; never resize or navigate a live call's window. */
export function openBroadcastWindow():boolean {
  const height=Math.floor(Math.min(900,Math.max(1,window.screen.availHeight-100),Math.max(1,window.screen.availWidth-40)*9/16));
  return Boolean(window.open('/workbench?broadcast=1',`${broadcastWindowName}-${crypto.randomUUID()}`,`popup=yes,width=${Math.floor(height*16/9)},height=${height}`));
}
/** Correct browser chrome once after this dedicated popup mounts, without a resize loop. */
export function fitBroadcastWindow() {
  if(!window.name.startsWith(broadcastWindowName+'-'))return;
  const chromeWidth=Math.max(0,window.outerWidth-window.innerWidth);
  const chromeHeight=Math.max(0,window.outerHeight-window.innerHeight);
  const height=Math.floor(Math.min(900,Math.max(1,window.screen.availHeight-chromeHeight-40),Math.max(1,window.screen.availWidth-chromeWidth-40)*9/16));
  try {window.resizeTo(Math.floor(height*16/9)+chromeWidth,height+chromeHeight);}catch{/* Browsers may keep their chosen size; the canvas still fits proportionally. */}
}

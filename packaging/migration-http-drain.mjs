// Temporary shutdown adapter for the two legacy HTTP-only Node services.
// Executed inside their network namespace; the inspector never publishes a port.
import { setTimeout as delay } from 'node:timers/promises';

let target;
for (let attempt = 0; attempt < 40; attempt++) {
  try {
    const targets = await fetch('http://127.0.0.1:9229/json/list').then(r => r.json());
    target = targets.find(item => item.type === 'node');
    if (target) break;
  } catch {}
  await delay(100);
}
if (!target) throw new Error('Container-local Node inspector did not become ready');
const url = new URL(target.webSocketDebuggerUrl);
if (url.hostname !== '127.0.0.1' || url.port !== '9229') throw new Error('Unexpected inspector address');
const ws = new WebSocket(url);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true });
  ws.addEventListener('error', reject, { once: true });
});
try {
  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Shutdown adapter installation timed out')), 10000);
    ws.addEventListener('message', event => {
      const response = JSON.parse(event.data);
      if (response.id !== 1) return;
      clearTimeout(timer);
      if (response.error || response.result?.exceptionDetails) reject(new Error('Shutdown adapter rejected'));
      else resolve(response.result?.result?.value);
    });
  });
  ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
    expression: `(() => {
      if (process.listenerCount('SIGTERM')) throw Error('Existing shutdown handler must be respected');
      const servers = process._getActiveHandles().filter(h => h.constructor?.name === 'Server' && h.listening && typeof h.close === 'function');
      if (servers.length !== 1) throw Error('Expected exactly one HTTP server');
      process.once('SIGTERM', () => {
        Promise.all(servers.map(server => new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
        }))).then(() => process.exit(0)).catch(error => console.error('HTTP drain failed:', error.message));
      });
      setTimeout(() => { process.getBuiltinModule('node:inspector').close(); }, 250);
      return 'installed';
    })()`, returnByValue: true
  }}));
  if (await reply !== 'installed') throw new Error('Unexpected shutdown adapter response');
} finally {
  ws.close();
}
await delay(500);
console.log('HTTP shutdown adapter installed; active requests will finish before exit.');

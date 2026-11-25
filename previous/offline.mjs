// Registers the offline worker and reports when the active worker confirms a complete cache.
// Every failure is silent: without service worker support the game behaves exactly as before.
function askStatus(worker, env) {
  return new Promise((resolve) => {
    const channel = new (env.MessageChannel ?? MessageChannel)();
    channel.port1.onmessage = (event) => resolve(event.data);
    worker.postMessage({ type: 'offline-status' }, [channel.port2]);
  });
}

async function start(env, onReady) {
  const container = env.navigator.serviceWorker;
  await container.register('./service-worker.js', { updateViaCache: 'none' });
  const registration = await container.ready;
  const status = await askStatus(registration.active, env);
  if (status && status.type === 'offline-status' && status.complete === true) onReady(status);
}

export function initOffline({ onReady = () => {}, env = globalThis } = {}) {
  try {
    if (!env.navigator || !('serviceWorker' in env.navigator) || env.isSecureContext === false) return;
    const run = () => { start(env, onReady).catch(() => {}); };
    if (env.document?.readyState === 'complete') run();
    else env.addEventListener('load', run, { once: true });
  } catch { /* the game works without the offline cache */ }
}

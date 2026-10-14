// Service worker for the installable staff app. The app always needs the server for live data,
// so it only shows a friendly page when the internet is down.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(() => new Response(
    '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<body style="font-family:system-ui;text-align:center;padding:40px 16px">' +
    '<h1>No connection</h1><p>The clinic server can\'t be reached. Check the internet and try again.</p>' +
    '<button onclick="location.reload()" style="padding:10px 18px;font-size:1rem">Try again</button></body>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } })));
});

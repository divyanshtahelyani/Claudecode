// Makes the reception and doctor screens installable as the "Clinic Staff" app.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => { /* app still works in the browser */ });
}

const isInstalled = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
let installPrompt = null;

window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  const btn = document.getElementById('installBtn');
  if (btn) btn.classList.remove('hidden');
});

document.addEventListener('DOMContentLoaded', () => {
  if (isInstalled()) document.getElementById('installHelp')?.classList.add('hidden');
  document.getElementById('installBtn')?.addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    document.getElementById('installBtn').classList.add('hidden');
  });
});

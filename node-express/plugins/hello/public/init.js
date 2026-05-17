// Loaded after the Hello Tools tab is injected.
// Use a delegated listener so we don't fight the rest of app.js.

document.addEventListener('click', async (e) => {
  if (e.target?.id !== 'hello-ping') return;
  const out = document.getElementById('hello-out');
  out.textContent = 'pinging...';
  try {
    const r = await fetch('/api/hello').then((x) => x.json());
    out.textContent = JSON.stringify(r, null, 2);
  } catch (err) {
    out.textContent = 'failed: ' + err.message;
  }
});

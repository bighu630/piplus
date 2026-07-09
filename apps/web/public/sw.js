// Minimal service worker for PWA installability
// Network-first pass-through — no caching
self.addEventListener('fetch', (e) => {
  e.respondWith(fetch(e.request));
});

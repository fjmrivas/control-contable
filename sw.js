// Service worker de ContaPRO+ — proyecto sin build step (un solo index.html servido
// como archivo estático), así que esto es JS plano sin Workbox ni bundler. El sistema
// depende de Supabase para casi todo, así que el objetivo NO es funcionar offline de
// verdad: es cargar más rápido en visitas repetidas y no romperse feo si se pierde la
// señal un momento.
//
// Versión manual del caché — súbela (v1 -> v2 -> ...) cuando cambies la lista de
// PRECACHE_URLS o quieras forzar que los clientes descarten cachés viejos; no hay hash
// de build que lo haga automático.
const CACHE_NAME = 'contapro-v1';

const PRECACHE_URLS = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/offline.html'
];

// CDNs con versión fija en la URL (xlsx@0.18.5, pdfjs-dist@3.11.174, jszip@3.10.1,
// @supabase/supabase-js@2) — seguros de cachear agresivo: una URL versionada nunca
// cambia de contenido.
const CDN_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names.filter((n) => n !== CACHE_NAME).map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

function cacheFirst(request) {
  return caches.match(request).then((cached) => {
    if (cached) return cached;
    return fetch(request).then((response) => {
      if (response && response.ok) {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
      }
      return response;
    });
  });
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // no interferir con POST/PUT/DELETE a Supabase

  // Navegación (carga de index.html): network-first. La app entera vive en ese único
  // archivo y se actualiza seguido, así que preferimos la versión más reciente cuando
  // hay internet — el caché es solo el salvavidas para cuando falla la red.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match('/offline.html'))
    );
    return;
  }

  const url = new URL(request.url);

  if (url.origin === self.location.origin) {
    if (url.pathname === '/manifest.json' || url.pathname.startsWith('/icons/')) {
      event.respondWith(cacheFirst(request));
    }
    return; // cualquier otra ruta same-origin (p.ej. el Worker de OCR si compartiera dominio) sin tocar
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request));
  }
  // Cualquier otro origen (Supabase, Worker de OCR en su propio dominio, etc.) —
  // sin interceptar: siempre va directo a la red.
});

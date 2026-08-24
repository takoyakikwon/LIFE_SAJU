// 사주풀이 PWA 서비스워커
// 목적: (1) 브라우저의 "홈 화면에 추가/설치" 조건(활성 서비스워커 + fetch 핸들러) 충족,
//       (2) 앱 껍데기(HTML/아이콘/매니페스트)를 캐싱해 재방문 시 더 빠르게 뜨고 오프라인에서도
//           최소한의 화면은 보이게 함.
// 캐시 버전을 올리면(CACHE_NAME 값 변경) 예전 캐시는 activate 단계에서 자동 정리됩니다.
// 새 배포를 반영하려면 이 값을 함께 올려주세요 — 안 올리면 사용자 기기에 예전 파일이 계속 캐싱될 수 있습니다.
const CACHE_NAME = 'saju-pwa-v1';

const APP_SHELL = [
  '/',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // GET 요청만 다룬다. /api/interpret 같은 POST 요청(실제 결제·AI 호출)은 서비스워커가
  // 절대 가로채지 않고 그대로 네트워크로 보낸다 — 캐싱하거나 오프라인 응답을 대신 주면 안 되는
  // 요청이기 때문.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  // 같은 출처(우리 앱) 요청만 다룬다. 구글 폰트 등 외부 CDN 요청은 브라우저 기본 동작에 맡긴다.
  if (url.origin !== self.location.origin) return;

  // 페이지 이동(HTML 문서) 요청: 최신 버전을 우선 받아오고, 오프라인일 때만 캐시된 화면으로 대체.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put('/', resClone));
          return res;
        })
        .catch(() => caches.match('/'))
    );
    return;
  }

  // 그 외 정적 파일(아이콘, 매니페스트 등): 캐시에 있으면 즉시 반환해 속도를 높이고,
  // 뒤에서 네트워크로 최신본을 받아 캐시를 갱신한다(stale-while-revalidate).
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request).then((res) => {
        if (res && res.ok) {
          const resClone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, resClone));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});

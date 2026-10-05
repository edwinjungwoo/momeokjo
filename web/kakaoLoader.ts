declare global {
  interface Window {
    kakao: any;
  }
}

const SDK_URL = "https://dapi.kakao.com/v2/maps/sdk.js";
const TIMEOUT_MS = 10_000;

// 모듈 전체에서 Promise 하나만 쓴다 (StrictMode 이중 실행에도 script는 한 번만 붙는다)
let cached: Promise<any> | null = null;

export function loadKakaoMaps(appKey: string): Promise<any> {
  if (!appKey) return Promise.reject(new Error("VITE_KAKAO_JS_KEY가 비어 있어요"));
  if (cached) return cached;
  cached = new Promise((resolve, reject) => {
    // 도메인 미등록, 키 오류, 광고 차단이면 load 콜백이 영영 안 올 수 있어서 10초 뒤 실패 처리한다
    const timer = window.setTimeout(() => fail(new Error("카카오맵 SDK 로드 시간 초과")), TIMEOUT_MS);
    function fail(err: Error) {
      window.clearTimeout(timer);
      cached = null; // 다음 시도에서 처음부터 다시 불러온다
      reject(err);
    }
    function ready() {
      window.kakao.maps.load(() => {
        window.clearTimeout(timer);
        resolve(window.kakao);
      });
    }
    if (window.kakao?.maps) {
      ready();
      return;
    }
    const s = document.createElement("script");
    // SDK는 이 URL 패턴의 script 태그에서 appkey를 읽는다. https 고정.
    s.src = `${SDK_URL}?appkey=${encodeURIComponent(appKey)}&autoload=false`;
    s.async = true;
    s.onload = () => (window.kakao?.maps ? ready() : fail(new Error("카카오맵 SDK 초기화 실패")));
    s.onerror = () => {
      s.remove();
      fail(new Error("카카오맵 SDK를 불러오지 못했어요"));
    };
    document.head.appendChild(s);
  });
  return cached;
}

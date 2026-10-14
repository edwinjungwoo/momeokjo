import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import { isAdminPath } from "../shared/share";
import App from "./App";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { readSettingsRaw } from "./deviceStore";
import { loadKakaoMaps } from "./kakaoLoader";
import { HUBS_WAIT_MS, loadPublicHubs, needsHubListFirst, primePublicHubs } from "./publicHubs";
import "./styles.css";

// R36: /admin은 따로 불러온다 (메인 번들에 넣지 않는다). Worker의 SPA 대체 응답이 /admin에도 index.html을 준다
const AdminPage = lazy(() => import("./admin/AdminPage"));
// /admin/(끝 슬래시)도 관리 화면으로 열고, 주소는 /admin으로 맞춘다
const isAdmin = isAdminPath(window.location.pathname);
if (isAdmin && window.location.pathname !== "/admin") {
  window.history.replaceState(null, "", `/admin${window.location.search}${window.location.hash}`);
}
// 관리 화면은 검색에 나오지 않게 한다 (Worker는 /api/*만 먼저 처리해서 헤더 대신 메타 태그로)
if (isAdmin) {
  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = "noindex, nofollow";
  document.head.appendChild(robots);
}

// R45: 지도 SDK는 React가 그리기를 기다리지 않고 지금 불러오기 시작한다 (index.html이 미리 받아 둔다).
// MapView는 같은 Promise를 이어 쓰고, 실패하면 거기서 다시 시도한다
if (!isAdmin) loadKakaoMaps(import.meta.env.VITE_KAKAO_JS_KEY).catch(() => {});

const render = () =>
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      {isAdmin ? (
        <Suspense fallback={null}>
          <AdminPage />
        </Suspense>
      ) : (
        // 그리다 던져도 흰 화면이 되지 않게 (예: 이상한 링크 — Task 56)
        <AppErrorBoundary>
          <App />
        </AppErrorBoundary>
      )}
    </StrictMode>,
  );

// R68: 배포 없이 공개된 거점(공개 후보)을 안다 — 기기에 기억한 목록을 바로 쓰고 /api/hubs를 뒤에서 받는다(후보가 없으면 부르지 않음).
// 저장값·링크가 아직 모르는 후보를 가리키면 그 목록을 잠깐(HUBS_WAIT_MS까지) 기다렸다 그린다 — 설정 시작값이 그 거점을 기본 거점으로 바꾸지 않게
primePublicHubs();
const hubsLoaded = loadPublicHubs();
if (!isAdmin && needsHubListFirst(readSettingsRaw(), window.location.pathname, window.location.search)) {
  void Promise.race([hubsLoaded, new Promise((ok) => setTimeout(ok, HUBS_WAIT_MS))]).then(render);
} else {
  render();
}

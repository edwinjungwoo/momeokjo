import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

// R36: /admin은 따로 불러온다 (메인 번들에 넣지 않는다). Worker의 SPA 대체 응답이 /admin에도 index.html을 준다
const AdminPage = lazy(() => import("./admin/AdminPage"));
const isAdmin = window.location.pathname === "/admin";
// 관리 화면은 검색에 나오지 않게 한다 (Worker는 /api/*만 먼저 처리해서 헤더 대신 메타 태그로)
if (isAdmin) {
  const robots = document.createElement("meta");
  robots.name = "robots";
  robots.content = "noindex, nofollow";
  document.head.appendChild(robots);
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {isAdmin ? (
      <Suspense fallback={null}>
        <AdminPage />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
);

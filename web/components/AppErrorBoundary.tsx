import { Component, type ReactNode } from "react";
import { ErrorState } from "./EmptyState";

/**
 * 화면 전체 오류 경계: 그리기·효과에서 던진 오류로 React가 화면을 통째로 지우지 않게(흰 화면) 오류 안내와
 * "다시 시도하기"를 보인다. 다시 시도는 첫 화면(/)으로 새로 연다 — 같은 주소(이상한 링크)로 다시 열면 또 던질 수 있어서
 */
export class AppErrorBoundary extends Component<{ children?: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: unknown): void {
    console.error("app crashed", error);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children ?? null;
    return (
      <main className="crash">
        <ErrorState onRetry={() => window.location.replace("/")} />
      </main>
    );
  }
}

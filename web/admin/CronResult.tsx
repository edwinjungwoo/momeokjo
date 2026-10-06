import type { CronSummary } from "../../shared/dashboard";
import { num } from "./format";

/** Task 34: D1 호출 예산으로 건너뛴 단계 이름 */
const STAGE: Record<string, string> = { expired: "만료 갱신", unfetched: "미수집 찾기", rollup: "집계" };

/**
 * 운영 탭 "그 실행 결과": 마지막 본 Cron의 격자·상세·외부 호출 수.
 * 읽기 예산으로 건너뛴 실행, 보충 저장 오류(enrichError), D1 호출 예산으로 건너뛴 단계(d1Skipped)는 경고 알약으로 보인다
 */
export function CronResult({ cron }: { cron: CronSummary | null }) {
  if (!cron) return <>–</>;
  if (cron.skipped) {
    return <span className="pill lv-warn">건너뜀 · {cron.skipped === "read_budget" ? "읽기 예산" : cron.skipped}</span>;
  }
  return (
    <>
      격자 {num(cron.collected)} · 상세 {num(cron.enriched)}
      {cron.failed > 0 ? ` (실패 ${num(cron.failed)})` : ""} · 외부 호출 {num(cron.calls)}
      {cron.rolled > 0 ? ` · 집계 ${cron.rolled}일` : ""}
      {cron.enrichError ? (
        <>
          {" "}
          <span className="pill lv-warn" title="상세 저장 중 오류 — 원인은 Workers 로그">저장 오류</span>
        </>
      ) : null}
      {cron.d1Skipped && cron.d1Skipped.length > 0 ? (
        <>
          {" "}
          <span className="pill lv-warn" title="실행당 D1 호출 50개 한도 안에서 다음 실행으로 미뤘어요">
            D1 예산으로 건너뜀 · {cron.d1Skipped.map((s) => STAGE[s] ?? s).join("·")}
          </span>
        </>
      ) : null}
    </>
  );
}

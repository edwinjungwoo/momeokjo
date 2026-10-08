import type { Hub } from "../../shared/hubs";

/**
 * R62 테스트 전용 준비 중 거점 — 운영 HUBS(shared/hubs.ts)에는 없다 (2026-10-08부터 운영 거점은 모두 공개).
 * 다음 거점도 같은 장치(ready: false)로 더하므로, 준비 중 동작은 이 거점으로 계속 확인한다.
 * 다른 거점 격자와 겹치지 않게 멀리(제주시) 두고, 갱신 요일은 비워 둔 일요일(0).
 */
export const UNREADY_HUB: Hub = { id: "testready", name: "준비중시험역", lat: 33.499621, lng: 126.531188, ready: false, refreshDay: 0 };

/**
 * 테스트 파일 맨 위에서:
 * `vi.mock("../../shared/hubs", async (orig) => (await import("../helpers/unreadyHub")).withUnreadyHub(orig));`
 * 진짜 모듈의 HUBS 끝에 UNREADY_HUB를 더한다 — isHubId·hubById·배경 작업(Cron·관리자)은 이 거점을 알고,
 * PUBLIC_HUBS는 모듈을 읽을 때 ready만 걸러 둔 목록이라 그대로 빠진다. 모듈은 테스트 파일마다 따로라 다른 파일로 새지 않는다.
 */
export async function withUnreadyHub<T extends { HUBS: Hub[] }>(importOriginal: () => Promise<T>): Promise<T> {
  const mod = await importOriginal();
  if (!mod.HUBS.some((h) => h.id === UNREADY_HUB.id)) mod.HUBS.push(UNREADY_HUB);
  return mod;
}

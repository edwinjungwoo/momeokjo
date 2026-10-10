import { describe, expect, it } from "vitest";
import { EMPTY_PERSONAL, addFavorite, addSignals, excludePlace, isFavorite, removeFavorite } from "../../shared/personal";
import { PERSONAL_KEY, latestPersonal, personalFromStorage } from "../../web/personal";

const NOW = 1_800_000_000_000;

describe("R37/R65 여러 탭 — 즐겨찾기·다음부터 안 보기를 다른 탭이 덮어 지우지 않는다", () => {
  it("R37/R65: 바꾸기 전에 저장본을 다시 읽어 그 위에 바꾼다 — 탭 2가 뺀 곳·넣은 즐겨찾기가 탭 1의 '모먹죠?'(shown 신호)로 지워지지 않는다", () => {
    // 탭 1은 열어 둔 채 (읽은 저장본 = 빈 값), 탭 2(Slack 공유 링크)에서 X를 빼고 Y를 ♡
    const tab1 = EMPTY_PERSONAL;
    const seenByTab1 = JSON.stringify(tab1);
    const tab2 = addFavorite(excludePlace(EMPTY_PERSONAL, "111", NOW), "222", NOW);
    const stored = JSON.stringify(tab2);
    const base = latestPersonal(tab1, seenByTab1, () => stored, NOW + 1000);
    const next = addSignals(base, [{ id: "333", group: "korean", kind: "shown", at: NOW + 1000 }], NOW + 1000);
    expect(Object.hasOwn(next.excluded, "111")).toBe(true);
    expect(isFavorite(next, "222")).toBe(true);
    expect(next.signals.map((s) => s.id)).toEqual(["333"]);
  });

  it("R65: 합치지 않고 다른 탭이 바꾼 값 위에 한다 — 다른 탭이 뺀 즐겨찾기를 되살리지 않는다", () => {
    const both = addFavorite(EMPTY_PERSONAL, "222", NOW);
    const tab1 = both;
    const stored = JSON.stringify(removeFavorite(both, "222"));
    const base = latestPersonal(tab1, JSON.stringify(both), () => stored, NOW + 1000);
    expect(isFavorite(base, "222")).toBe(false);
  });

  it("R37: 저장본이 이 탭이 마지막으로 읽거나 쓴 값 그대로면 이 탭 상태를 그대로 쓴다(같은 객체) · 읽지 못하면 이 탭 상태(이번 세션만)", () => {
    const tab1 = addFavorite(EMPTY_PERSONAL, "222", NOW);
    const json = JSON.stringify(tab1);
    expect(latestPersonal(tab1, json, () => json, NOW)).toBe(tab1);
    expect(latestPersonal(tab1, json, () => {
      throw new Error("SecurityError");
    }, NOW)).toBe(tab1);
    // 저장이 실패했던 탭(저장본은 예전 값 그대로 = 이 탭이 본 값)은 이 탭에만 있는 바꾼 값을 지키고 다음에 다시 저장한다
    expect(latestPersonal(tab1, null, () => null, NOW)).toBe(tab1);
  });

  it("R37/R65: 다른 탭이 저장하면(storage 이벤트) 이 탭 상태를 그 값으로 바꾼다 — 화면(♡·내 가게·뽑기)도 바로 맞는다. 다른 키는 무시, clear()는 빈 값", () => {
    const tab2 = addFavorite(excludePlace(EMPTY_PERSONAL, "111", NOW), "222", NOW);
    const next = personalFromStorage(PERSONAL_KEY, JSON.stringify(tab2), NOW + 1000);
    expect(next && isFavorite(next, "222")).toBe(true);
    expect(next && Object.hasOwn(next.excluded, "111")).toBe(true);
    expect(personalFromStorage("mmj:seen:v1", "{}", NOW)).toBeNull();
    expect(personalFromStorage(null, null, NOW)).toEqual(EMPTY_PERSONAL);
  });
});

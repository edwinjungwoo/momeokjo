import { describe, expect, it } from "vitest";
import {
  INTERVAL_WEEKS, MAX_INTERVAL_WEEKS, SHOW_REFRESH_AFTER_MS, WEEK_MS, detailFingerprint, dueAfterOf, fpKind, idHash, refreshGapWeeks,
  weekIndex,
} from "../../shared/adaptiveRefresh";
import { refreshStart } from "../../shared/refresh";
import type { PlaceDetail, PlaceSummary } from "../../shared/types";

const summary = (o: Partial<PlaceSummary> = {}): PlaceSummary => ({
  name: "중앙해장", categoryName: "음식점 > 한식 > 해장국", lat: 37.51, lng: 127.06, address: "서울 강남구 영동대로 1",
  phone: "02-123-4567", photoUrl: "https://t1.kakaocdn.net/a.jpg", ...o,
});
const detail = (o: Partial<PlaceDetail> = {}): PlaceDetail => ({
  rating: 4.23, reviewCount: 120, price: 12000,
  menus: [{ name: "해장국", price: 12000 }, { name: "수육", price: 30000 }],
  hours: { 1: [[660, 1320]], 0: "closed" }, strengths: ["맛", "친절"], bookable: false, tags: ["혼밥"], ...o,
});

describe("R66 표시 정보 지문 (fp)", () => {
  it("R66: 같은 표시 정보면 같은 지문 — 결정적이고 짧은 문자열 (영업시간 키 순서·구간 순서와 상관없다)", () => {
    const a = detailFingerprint(summary(), detail());
    expect(a).toBe(detailFingerprint(summary(), detail()));
    expect(a).toMatch(/^[0-9a-f]{8}$/);
    const reordered = detailFingerprint(summary(), detail({ hours: { 0: "closed", 1: [[660, 1320]] } }));
    expect(reordered).toBe(a);
    const twoSlots = (h: [number, number][]) => detailFingerprint(summary(), detail({ hours: { 1: h } }));
    expect(twoSlots([[1020, 1320], [660, 900]])).toBe(twoSlots([[660, 900], [1020, 1320]]));
  });

  it("R66: 리뷰 수·사진·주소·좌표만 바뀌면 같은 지문이다 (바뀐 것으로 치지 않는다), 평점은 0.1 단위로 본다", () => {
    const a = detailFingerprint(summary(), detail());
    expect(detailFingerprint(summary(), detail({ reviewCount: 999 }))).toBe(a);
    expect(detailFingerprint(summary({ photoUrl: null }), detail())).toBe(a);
    expect(detailFingerprint(summary({ photoUrl: "https://t1.kakaocdn.net/b.jpg" }), detail())).toBe(a);
    expect(detailFingerprint(summary({ address: "다른 주소", lat: 37.52, lng: 127.07 }), detail())).toBe(a);
    // 4.23 → 4.2, 4.24 → 4.2 (같음), 4.26 → 4.3 (다름)
    expect(detailFingerprint(summary(), detail({ rating: 4.24 }))).toBe(a);
    expect(detailFingerprint(summary(), detail({ rating: 4.26 }))).not.toBe(a);
  });

  it("R66: 이름·카테고리·평점·가격·영업시간·메뉴(이름·가격·순서)·전화·예약·강점·혼밥/단체 판단이 바뀌면 다른 지문이다", () => {
    const a = detailFingerprint(summary(), detail());
    const changed = [
      detailFingerprint(summary({ name: "중앙해장 본점" }), detail()),
      detailFingerprint(summary({ categoryName: "음식점 > 한식" }), detail()),
      detailFingerprint(summary(), detail({ rating: null })),
      detailFingerprint(summary(), detail({ price: 13000 })),
      detailFingerprint(summary(), detail({ hours: { 1: [[660, 1300]], 0: "closed" } })),
      detailFingerprint(summary(), detail({ hours: null })),
      detailFingerprint(summary(), detail({ menus: [{ name: "해장국", price: 13000 }, { name: "수육", price: 30000 }] })),
      detailFingerprint(summary(), detail({ menus: [{ name: "수육", price: 30000 }, { name: "해장국", price: 12000 }] })),
      detailFingerprint(summary(), detail({ menus: [{ name: "해장국", price: 12000 }] })),
      detailFingerprint(summary({ phone: null }), detail()),
      detailFingerprint(summary(), detail({ bookable: true })),
      detailFingerprint(summary(), detail({ strengths: ["맛"] })),
      detailFingerprint(summary(), detail({ tags: ["단체석"] })),
    ];
    for (const [i, fp] of changed.entries()) expect(fp, String(i)).not.toBe(a);
    // 혼밥 판단에 쓰이지 않는 태그만 바뀌면 화면에 보이는 것이 같다
    expect(detailFingerprint(summary(), detail({ tags: ["혼밥", "주차"] }))).toBe(a);
  });

  it("R66 Fix 2: 강점·태그는 순서만 바뀌면 같은 지문이다 (메뉴는 화면 순서라 순서도 본다)", () => {
    const a = detailFingerprint(summary(), detail({ strengths: ["맛", "친절", "가성비"], tags: ["혼밥", "단체석"] }));
    expect(detailFingerprint(summary(), detail({ strengths: ["가성비", "맛", "친절"], tags: ["단체석", "혼밥"] }))).toBe(a);
    expect(detailFingerprint(summary(), detail({ strengths: ["맛", "친절"], tags: ["혼밥", "단체석"] }))).not.toBe(a);
  });

  it("R66: 이전 지문과 비교 — 없으면 first, 같으면 same, 다르면 changed", () => {
    expect(fpKind(null, "abcd1234")).toBe("first");
    expect(fpKind(undefined, "abcd1234")).toBe("first");
    expect(fpKind("abcd1234", "abcd1234")).toBe("same");
    expect(fpKind("abcd1234", "0000ffff")).toBe("changed");
  });

  it("R66: 주기는 1·2·4주, 다음 갱신 기준 = 가져온 시각 + (간격 − 1) × 7일, 열어 본 가게는 7일이 지나면 다시 가져온다", () => {
    expect(INTERVAL_WEEKS).toEqual([1, 2, 4]);
    expect(MAX_INTERVAL_WEEKS).toBe(4);
    expect(WEEK_MS).toBe(7 * 24 * 3600_000);
    expect(SHOW_REFRESH_AFTER_MS).toBe(7 * 24 * 3600_000);
    expect(dueAfterOf(1000, 1)).toBe(1000);
    expect(dueAfterOf(1000, 2)).toBe(1000 + WEEK_MS);
    expect(dueAfterOf(1000, 4)).toBe(1000 + 3 * WEEK_MS);
  });
});

describe("R66 Fix 1 — 주기 2·4주 가게를 id 위상으로 흩는다", () => {
  const T = Date.UTC(2026, 9, 10, 3); // 2026-10-10 12:00 KST
  const IDS = Array.from({ length: 4000 }, (_, i) => String(1_000_000 + i * 7919));

  it("R66: 간격은 1 ≤ 간격 ≤ 주기이고, (가져온 주 + 간격) ≡ hash(id) mod 주기 — 주기 1은 언제나 1, 해시는 지터와 같은 해시", () => {
    for (const id of IDS.slice(0, 200)) {
      expect(refreshGapWeeks(id, T, 1)).toBe(1);
      for (const n of [2, 4]) {
        const g = refreshGapWeeks(id, T, n);
        expect(g).toBeGreaterThanOrEqual(1);
        expect(g).toBeLessThanOrEqual(n);
        expect((weekIndex(T) + g) % n).toBe(idHash(id) % n);
      }
    }
    expect(weekIndex(T)).toBe(Math.floor((T + 9 * 3600_000 - 4 * 24 * 3600_000) / WEEK_MS));
    expect(idHash("a")).toBe(idHash("a"));
    expect(idHash("a")).not.toBe(idHash("b"));
  });

  it("R66: 같은 때 가져온 많은 가게 중 어느 한 주에 돌아오는 몫은 주기 2면 ≈ 1/2, 4면 ≈ 1/4 (한 주에 몰리지 않는다)", () => {
    for (const n of [2, 4]) {
      const byWeek = new Map<number, number>();
      for (const id of IDS) {
        const w = weekIndex(T) + refreshGapWeeks(id, T, n);
        byWeek.set(w, (byWeek.get(w) ?? 0) + 1);
      }
      expect(byWeek.size, String(n)).toBe(n);
      for (const [w, c] of byWeek) expect(Math.abs(c / IDS.length - 1 / n), `${n} @${w}`).toBeLessThan(0.03);
    }
  });

  it("R66 Fix 2: 주는 월요일 00:00 KST에 바뀐다 (일요일 23:59 KST는 앞 주, 목요일은 경계가 아니다)", () => {
    const kst = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h - 9, mi);
    expect(new Date(kst(2026, 10, 12) + 9 * 3600_000).getUTCDay()).toBe(1); // 2026-10-12는 월요일
    expect(weekIndex(kst(2026, 10, 12))).toBe(weekIndex(kst(2026, 10, 11, 23, 59)) + 1);
    expect(weekIndex(kst(2026, 10, 12) - 1)).toBe(weekIndex(kst(2026, 10, 5)));
    expect(weekIndex(kst(2026, 10, 18, 23, 59))).toBe(weekIndex(kst(2026, 10, 12)));
    expect(weekIndex(kst(2026, 10, 15))).toBe(weekIndex(kst(2026, 10, 14, 23, 59))); // 목 00:00 KST
    expect(weekIndex(kst(2026, 10, 15, 9))).toBe(weekIndex(kst(2026, 10, 15, 8, 59))); // 목 09:00 KST (UTC 목 00:00)
  });

  it("R66 Fix 2: 목요일 갱신 거점에서 시작 뒤 0~40시간 안에 다시 가져오면 여러 주가 지나도 간격이 정확히 주기다 (짧아지지 않는다)", () => {
    const thu = Date.UTC(2026, 9, 7, 15); // 2026-10-08 00:00 KST 목요일
    expect(refreshStart(4, thu)).toBe(thu);
    const H40 = 40 * 3600_000;
    for (const id of IDS.slice(0, 500)) {
      for (const n of [2, 4]) {
        // k번째 주의 갱신 시작 + 가게·주마다 다른 0~40시간에 가져온다. 다음 갱신 = due_after보다 늦은 첫 시작의 주
        const fetchAt = (k: number) => thu + k * WEEK_MS + (idHash(`${id}:${k}`) % (H40 + 1));
        let k = 0;
        const weeks = [k];
        for (let i = 0; i < 8; i++) {
          const t = fetchAt(k);
          const due = dueAfterOf(t, refreshGapWeeks(id, t, n));
          let next = k + 1;
          while (!(due < thu + next * WEEK_MS)) next += 1;
          k = next;
          weeks.push(k);
        }
        const gaps = weeks.slice(1).map((w, i) => w - weeks[i]);
        expect(gaps[0], `${id} n=${n}`).toBeGreaterThanOrEqual(1);
        expect(gaps[0], `${id} n=${n}`).toBeLessThanOrEqual(n);
        expect(gaps.slice(1), `${id} n=${n}`).toEqual(Array(gaps.length - 1).fill(n));
      }
    }
  });

  it("R66: 첫 간격 뒤에는 정확히 주기마다 — 같은 가게의 위상이 그대로다 (같은 요일·시각에 다시 가져올 때)", () => {
    for (const id of IDS.slice(0, 300)) {
      for (const n of [1, 2, 4]) {
        let t = T + (idHash(id) % 7) * 24 * 3600_000; // 가게마다 다른 요일
        t += refreshGapWeeks(id, t, n) * WEEK_MS;
        for (let k = 0; k < 4; k++) {
          const g = refreshGapWeeks(id, t, n);
          expect(g, `${id} n=${n}`).toBe(n);
          t += g * WEEK_MS;
        }
      }
    }
  });
});

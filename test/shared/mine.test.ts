import { describe, expect, it, vi } from "vitest";
import {
  MAX_RECENT, NEAR_HUB_LABEL_M, NEAR_HUB_MOVE_M, excludedIds, favoriteIds, mineSections, nearestHub, placeLine, recentIds,
} from "../../shared/mine";
import { EMPTY_PERSONAL, type PersonalState, type Signal, type Snapshot } from "../../shared/personal";
import { UNREADY_HUB } from "../helpers/unreadyHub";

// R62: 준비 중 거점은 "근처" 표시에도, 거점 옮기기에도 쓰지 않는다 — 테스트 전용 준비 중 거점을 HUBS에 더한다
vi.mock("../../shared/hubs", async (orig) => (await import("../helpers/unreadyHub")).withUnreadyHub(orig));

const NOW = Date.parse("2026-10-09T12:00:00+09:00");
const H = 3600_000;
const D = 24 * H;
const BONGEUNSA = { lat: 37.514255, lng: 127.060234 };
const PANGYO = { lat: 37.394777, lng: 127.11159 };
/** 판교역에서 북쪽으로 약 1.1km (다른 공개 역은 훨씬 멀다) */
const PANGYO_1100 = { lat: PANGYO.lat + 0.0099, lng: PANGYO.lng };

const sig = (kind: Signal["kind"], ageMs: number, id: string): Signal => ({ id, group: "korean", kind, at: NOW - ageMs });
const snap = (name: string, o: Partial<Snapshot> = {}): Snapshot => ({ name, group: "korean", ...BONGEUNSA, at: NOW, ...o });

describe("R65 내 가게 — 목록 만들기", () => {
  it("R65: 가까운 공개 역 — 1.2km 안에서 가장 가까운 곳, 준비 중 역은 보지 않는다", () => {
    expect(NEAR_HUB_LABEL_M).toBe(1200);
    expect(NEAR_HUB_MOVE_M).toBe(1000);
    expect(nearestHub(BONGEUNSA, NEAR_HUB_LABEL_M)?.id).toBe("bongeunsa");
    expect(nearestHub(PANGYO_1100, NEAR_HUB_LABEL_M)?.id).toBe("pangyo");
    // 1.1km는 "근처" 표시는 되지만 거점을 옮길 만큼 가깝지는 않다
    expect(nearestHub(PANGYO_1100, NEAR_HUB_MOVE_M)).toBeNull();
    expect(nearestHub({ lat: 37.3, lng: 127.0 }, NEAR_HUB_LABEL_M)).toBeNull();
    expect(nearestHub(UNREADY_HUB, NEAR_HUB_LABEL_M)).toBeNull();
  });

  it("R65: 줄 설명 — '{세부 종류} · {가까운 공개 역} 근처', 역이 멀면 종류만", () => {
    expect(placeLine("국밥", BONGEUNSA)).toBe("국밥 · 봉은사역 근처");
    expect(placeLine("국밥", { lat: 37.3, lng: 127.0 })).toBe("국밥");
    expect(placeLine(undefined, PANGYO)).toBe("판교역 근처");
    expect(placeLine(undefined, null)).toBe("");
  });

  it("R65: 즐겨찾기·뺀 곳은 최근에 한 것부터", () => {
    const s: PersonalState = { ...EMPTY_PERSONAL, favorites: { "1": NOW - D, "2": NOW, "3": NOW - H }, excluded: { "7": NOW - H, "8": NOW } };
    expect(favoriteIds(s)).toEqual(["2", "3", "1"]);
    expect(excludedIds(s)).toEqual(["8", "7"]);
  });

  it("R65: 최근 열어 본 곳 — 30일 안 카카오맵·공유, 최근 것부터, 한 번씩, 즐겨찾기·뺀 곳 빼고, 최대 20곳", () => {
    expect(MAX_RECENT).toBe(20);
    const s: PersonalState = {
      ...EMPTY_PERSONAL,
      signals: [
        sig("kakao_open", 5 * D, "a"),
        sig("shared", 2 * D, "b"),
        sig("kakao_open", H, "a"), // 같은 곳을 또 열면 그 시각으로 한 번만
        sig("shown", 0, "shown"), // 보여주기·받기는 "열어 본 곳"이 아니다
        sig("received", 0, "recv"),
        sig("kakao_open", 31 * D, "old"),
        sig("kakao_open", 3 * D, "fav"),
        sig("shared", 4 * D, "hid"),
      ],
      favorites: { fav: NOW },
      excluded: { hid: NOW },
    };
    expect(recentIds(s, NOW)).toEqual(["a", "b"]);
    // 이름을 모르는 곳은 건너뛰고 다음 곳으로 채운다
    expect(recentIds(s, NOW, (id) => id !== "a")).toEqual(["b"]);
    const many: PersonalState = {
      ...EMPTY_PERSONAL,
      signals: Array.from({ length: 25 }, (_, i) => sig("kakao_open", (25 - i) * H, `p${i}`)),
    };
    const ids = recentIds(many, NOW);
    expect(ids).toHaveLength(MAX_RECENT);
    expect(ids[0]).toBe("p24");
    expect(ids.at(-1)).toBe("p5");
  });

  it("R65: 세 묶음 — 이름은 지금 목록 → 기억한 이름 순, 모르면 뺀 곳은 '이전에 뺀 가게', 최근 곳은 건너뛴다", () => {
    const s: PersonalState = {
      ...EMPTY_PERSONAL,
      signals: [sig("kakao_open", H, "r1"), sig("shared", 2 * H, "r2")],
      favorites: { f1: NOW },
      excluded: { x1: NOW, x2: NOW - H },
      snapshots: {
        f1: snap("중앙해장", { cat: "해장국" }),
        r1: snap("예전 이름", { cat: "국밥", ...PANGYO }),
        x1: snap("만리장성", { cat: "중국요리", lat: 37.3, lng: 127.0 }),
      },
    };
    const live = (id: string) =>
      id === "r1" ? { name: "새 이름", category: "음식점 > 한식 > 국밥", ...PANGYO } : undefined;
    const m = mineSections(s, NOW, live);
    expect(m.favorites).toEqual([{ id: "f1", name: "중앙해장", line: "해장국 · 봉은사역 근처", pos: BONGEUNSA }]);
    // r2는 이름도 기억도 없어 건너뛴다
    expect(m.recent).toEqual([{ id: "r1", name: "새 이름", line: "국밥 · 판교역 근처", pos: PANGYO }]);
    expect(m.excluded).toEqual([
      { id: "x1", name: "만리장성", line: "중국요리", pos: { lat: 37.3, lng: 127.0 } },
      { id: "x2", name: "이전에 뺀 가게", line: "", pos: null },
    ]);
    expect(mineSections(EMPTY_PERSONAL, NOW, () => undefined)).toEqual({ favorites: [], recent: [], excluded: [] });
  });
});

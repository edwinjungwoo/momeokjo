import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS } from "../../shared/recommend";
import { parseHubPath, parseShareParams, shareText, shareUrl } from "../../shared/share";
import { HUBS } from "../../shared/hubs";
import wranglerRaw from "../../wrangler.jsonc?raw";
import { apiPlace } from "../helpers/apiPlace";

const ORIGIN = "https://mmj.itmz.me";
const A = apiPlace("27531028", { name: "중앙해장", category: "음식점 > 한식 > 해장국", walkMinutes: 4 }, { rating: 4.1 });
const B = apiPlace("13583324", { name: "만리장성", category: "음식점 > 중식 > 중국요리", walkMinutes: 7 }, { rating: 3.85 });
const C = apiPlace("960962816", { name: "스시하루", category: "음식점 > 일식 > 초밥,롤", walkMinutes: 9 }, { rating: null });

describe("R23′ 3곳 공유", () => {
  it("R23′/R43: 공유 URL은 거점 경로 + t(id 1~3개, 쉼표)와 r", () => {
    expect(shareUrl(ORIGIN, ["27531028", "13583324", "960962816"], "bongeunsa", 700)).toBe(
      "https://mmj.itmz.me/bongeunsa?t=27531028,13583324,960962816&r=700",
    );
    expect(shareUrl(ORIGIN, ["1"], "ddp", 500)).toBe("https://mmj.itmz.me/ddp?t=1&r=500");
  });

  it("R23′: 3곳 공유 문구 — '점심 고?'로 시작하고 '이 중에 어디 갈래요?'와 t 링크로 끝난다", () => {
    expect(shareText([A, B, C], { ...DEFAULT_FILTERS, party: 4, radius: 700 }, "bongeunsa", ORIGIN)).toBe(
      [
        "🍚 점심 고? (4명+ · 봉은사역 반경 700m)",
        "1. 중앙해장 · 해장국 · ★4.1 · 도보 4분",
        "2. 만리장성 · 중국요리 · ★3.9 · 도보 7분",
        "3. 스시하루 · 초밥,롤 · 도보 9분",
        "이 중에 어디 갈래요? 👉 https://mmj.itmz.me/bongeunsa?t=27531028,13583324,960962816&r=700",
      ].join("\n"),
    );
  });

  it("R23′: 평점이 없으면 ★를 생략하고, 2곳이면 2줄만", () => {
    const text = shareText([C, A], { ...DEFAULT_FILTERS, party: 2, radius: 500 }, "ddp", ORIGIN);
    expect(text.split("\n")).toEqual([
      "🍚 점심 고? (2명 · 동대문역사문화공원역 반경 500m)",
      "1. 스시하루 · 초밥,롤 · 도보 9분",
      "2. 중앙해장 · 해장국 · ★4.1 · 도보 4분",
      "이 중에 어디 갈래요? 👉 https://mmj.itmz.me/ddp?t=960962816,27531028&r=500",
    ]);
    expect(text).not.toMatch(/★(undefined|null)|점심 ㄱ/);
  });

  it("R23′: 1곳만 공유하면 '여기 어때요?'로 묻는다", () => {
    expect(shareText([A], { ...DEFAULT_FILTERS, party: 1, radius: 300 }, "pangyo", ORIGIN).split("\n")).toEqual([
      "🍚 점심 고? (1명 · 판교역 반경 300m)",
      "1. 중앙해장 · 해장국 · ★4.1 · 도보 4분",
      "여기 어때요? 👉 https://mmj.itmz.me/pangyo?t=27531028&r=300",
    ]);
  });

  it("R23′: t 파싱 — 숫자 1~15자리만, 중복 제거, 최대 3개, 빈 칸 무시", () => {
    const t = (v: string) => parseShareParams(`?t=${v}`).placeIds;
    expect(t("1,2,3")).toEqual(["1", "2", "3"]);
    expect(t("1,1,2")).toEqual(["1", "2"]);
    expect(t("1,,2")).toEqual(["1", "2"]);
    expect(t("a,2")).toEqual(["2"]);
    expect(t("1,2,3,4")).toEqual(["1", "2", "3"]);
    expect(t("1234567890123456")).toEqual([]);
    expect(t("123456789012345")).toEqual(["123456789012345"]);
    expect(t("1%2C2")).toEqual(["1", "2"]);
    expect(t("abc,,13583324,13583324")).toEqual(["13583324"]);
  });

  it("R23′: 예전 p 링크도 읽는다 (t가 있으면 t가 우선)", () => {
    expect(parseShareParams("?p=13583324&h=ddp&r=300")).toEqual({ placeIds: ["13583324"], hubId: "ddp", radius: 300 });
    expect(parseShareParams("?t=1,2&p=3").placeIds).toEqual(["1", "2"]);
    expect(parseShareParams("?p=abc").placeIds).toEqual([]);
  });

  it("R23: 공유 파라미터 파싱 — 유효한 값만 받는다 (거점은 목록에 있는 id만, lat/lng는 무시)", () => {
    expect(parseShareParams("?t=27531028&h=ddp&r=700")).toEqual({ placeIds: ["27531028"], hubId: "ddp", radius: 700 });
    expect(parseShareParams("?t=abc&h=gangnam&r=5000")).toEqual({ placeIds: [], hubId: null, radius: null });
    expect(parseShareParams("?p=1&lat=37.5&lng=127.05&r=1000")).toEqual({ placeIds: ["1"], hubId: null, radius: 1000 });
    expect(parseShareParams("?h=__proto__").hubId).toBeNull();
    expect(parseShareParams("?r=1050").radius).toBeNull();
    expect(parseShareParams("?r=99").radius).toBeNull();
    expect(parseShareParams("?r=325").radius).toBeNull();
    expect(parseShareParams("?r=500.5").radius).toBeNull();
    expect(parseShareParams("")).toEqual({ placeIds: [], hubId: null, radius: null });
  });

  it("R43: 새 공유 링크는 경로의 거점을 읽고, 예전 h 링크도 계속 읽는다", () => {
    expect(parseShareParams("?t=1,2&r=700", "/ddp")).toEqual({ placeIds: ["1", "2"], hubId: "ddp", radius: 700 });
    expect(parseShareParams("?t=1&h=pangyo", "/")).toEqual({ placeIds: ["1"], hubId: "pangyo", radius: null });
    // 둘 다 있으면 경로가 우선
    expect(parseShareParams("?t=1&h=pangyo", "/ddp").hubId).toBe("ddp");
    expect(parseShareParams("?t=1", "/brand").hubId).toBeNull();
  });
});

describe("R43 거점 짧은 링크", () => {
  it("R43: /pangyo로 열면 판교역 거점 (끝 / 허용)", () => {
    expect(parseHubPath("/pangyo")).toBe("pangyo");
    expect(parseHubPath("/pangyo/")).toBe("pangyo");
    for (const h of ["bongeunsa", "ddp", "naebang", "gwacheon"]) expect(parseHubPath(`/${h}`)).toBe(h);
  });

  it("R43: /brand 같은 모르는 경로, 하위 경로, 대문자, 루트는 무시", () => {
    for (const p of ["/", "", "/brand", "/brand/logo.png", "/admin", "/api/places", "/pangyo/x", "/PANGYO", "/__proto__", "//pangyo"]) {
      expect(parseHubPath(p), p).toBeNull();
    }
  });

  it("R43: 거점 id는 정적 파일·폴더, /admin, /api, /assets와 겹치지 않는다", () => {
    const publicTop = Object.keys(import.meta.glob("../../public/**/*", { query: "?url", import: "default" })).map(
      (f) => f.replace("../../public/", "").split("/")[0].replace(/\.[^.]+$/, ""),
    );
    expect(publicTop).toContain("brand");
    const reserved = new Set([...publicTop, "admin", "api", "assets", "index"]);
    for (const h of HUBS) expect(reserved.has(h.id), h.id).toBe(false);
  });

  it("R43: Worker는 /api/*만 먼저 처리하고 나머지는 정적 파일 → SPA 대체 응답(index.html)", () => {
    const cfg = JSON.parse(wranglerRaw.replace(/^\s*\/\/.*$/gm, ""));
    expect(cfg.assets).toEqual({ not_found_handling: "single-page-application", run_worker_first: ["/api/*"] });
  });
});

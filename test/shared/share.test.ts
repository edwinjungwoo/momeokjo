import { describe, expect, it } from "vitest";
import { DEFAULT_FILTERS } from "../../shared/recommend";
import { isAdminPath, parseHubPath, parseShareParams, shareConfirmText, shareText, shareUrl, toParticle } from "../../shared/share";
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
    expect(parseShareParams("?t=abc&h=atlantis&r=5000")).toEqual({ placeIds: [], hubId: null, radius: null });
    expect(parseShareParams("?p=1&lat=37.5&lng=127.05&r=1000")).toEqual({ placeIds: ["1"], hubId: null, radius: 1000 });
    expect(parseShareParams("?h=__proto__").hubId).toBeNull();
    expect(parseShareParams("?r=1050").radius).toBeNull();
    expect(parseShareParams("?r=99").radius).toBeNull();
    expect(parseShareParams("?r=325").radius).toBeNull();
    expect(parseShareParams("?r=500.5").radius).toBeNull();
    expect(parseShareParams("")).toEqual({ placeIds: [], hubId: null, radius: null });
  });

  it("R23: r은 Number로 읽어 100~1000m·50m 단위만 받는다 (1e3·0x1f4처럼 같은 값의 다른 표기는 허용, 빈 값·공백·음수는 버림)", () => {
    expect(parseShareParams("?r=1e3").radius).toBe(1000);
    expect(parseShareParams("?r=0x1f4").radius).toBe(500);
    for (const r of ["", "%20", "-500", "abc", "Infinity", "1001"]) expect(parseShareParams(`?r=${r}`).radius, r).toBeNull();
  });

  it("R43: 새 공유 링크는 경로의 거점을 읽고, 예전 h 링크도 계속 읽는다", () => {
    expect(parseShareParams("?t=1,2&r=700", "/ddp")).toEqual({ placeIds: ["1", "2"], hubId: "ddp", radius: 700 });
    expect(parseShareParams("?t=1&h=pangyo", "/")).toEqual({ placeIds: ["1"], hubId: "pangyo", radius: null });
    // 둘 다 있으면 경로가 우선
    expect(parseShareParams("?t=1&h=pangyo", "/ddp").hubId).toBe("ddp");
    expect(parseShareParams("?t=1", "/brand").hubId).toBeNull();
  });

  it("R62: 준비 중 거점은 공유 링크(경로·h)와 짧은 링크에서 모르는 거점처럼 null", () => {
    for (const id of ["gangnam", "yeouido", "gwanghwamun"]) {
      expect(parseHubPath(`/${id}`), id).toBeNull();
      expect(parseHubPath(`/${id}/`), id).toBeNull();
      expect(parseShareParams("?t=1,2&r=700", `/${id}`).hubId, id).toBeNull();
      expect(parseShareParams(`?t=1&h=${id}`).hubId, id).toBeNull();
    }
    // 준비 중 경로가 있어도 예전 h의 공개 거점은 읽는다
    expect(parseShareParams("?t=1&h=ddp", "/gangnam").hubId).toBe("ddp");
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

  it("R36: 관리 화면은 /admin과 /admin/(끝 슬래시) 둘 다, 그 밖의 경로는 아니다", () => {
    expect(isAdminPath("/admin")).toBe(true);
    expect(isAdminPath("/admin/")).toBe(true);
    for (const p of ["/", "", "/admin/x", "/admin//", "/administrator", "/ADMIN", "//admin", "/pangyo"]) {
      expect(isAdminPath(p), p).toBe(false);
    }
  });

  it("R43: Worker는 /api/*만 먼저 처리하고 나머지는 정적 파일 → SPA 대체 응답(index.html)", () => {
    const cfg = JSON.parse(wranglerRaw.replace(/^\s*\/\/.*$/gm, ""));
    expect(cfg.assets).toEqual({ not_found_handling: "single-page-application", run_worker_first: ["/api/*"] });
  });
});

describe("R47 \"여기로 가요\" 확정 공유", () => {
  it("R47: 한 곳 확정 문구 — 👉 이름(으)로 가요! 도보 N분, 카카오맵 링크, 그 한 곳의 t 링크", () => {
    expect(shareConfirmText(A, "bongeunsa", 700, ORIGIN)).toBe(
      ["👉 중앙해장으로 가요! 도보 4분", "http://place.map.kakao.com/27531028", "https://mmj.itmz.me/bongeunsa?t=27531028&r=700"].join("\n"),
    );
    expect(shareConfirmText(C, "ddp", 500, ORIGIN).split("\n")).toEqual([
      "👉 스시하루로 가요! 도보 9분",
      "http://place.map.kakao.com/960962816",
      "https://mmj.itmz.me/ddp?t=960962816&r=500",
    ]);
  });

  it("R47: 도보 시간을 모르면 도보 부분을 생략한다", () => {
    const p = apiPlace("1", { name: "스시하루", walkMinutes: undefined });
    expect(shareConfirmText(p, "bongeunsa", 500, ORIGIN).split("\n")[0]).toBe("👉 스시하루로 가요!");
  });

  it("R47: 조사 — 받침이 있으면(ㄹ 제외) '으로', 없거나 ㄹ이거나 한글이 아니면 '로'. 끝의 괄호·공백은 건너뛴다", () => {
    expect(toParticle("중앙해장")).toBe("으로");
    expect(toParticle("스시하루")).toBe("로");
    expect(toParticle("카페 서울")).toBe("로");
    expect(toParticle("중앙해장(본점)")).toBe("으로");
    expect(toParticle("BHC")).toBe("로");
    expect(toParticle("")).toBe("로");
  });

  it("R47: 끝이 숫자면 읽는 소리의 받침으로 — 0 영·3 삼·6 육은 '으로', 1 일·7 칠·8 팔(ㄹ)과 2·4·5·9는 '로'", () => {
    const want: Record<string, "으로" | "로"> = {
      0: "으로", 1: "로", 2: "로", 3: "으로", 4: "로", 5: "로", 6: "으로", 7: "로", 8: "로", 9: "로",
    };
    for (const [d, particle] of Object.entries(want)) expect(toParticle(`포차${d}`), `포차${d}`).toBe(particle);
    expect(toParticle("공방 1983")).toBe("으로");
    expect(toParticle("스테이크 27")).toBe("로");
    expect(toParticle("Bar 30 (2F)")).toBe("로");
  });

  it("R47: 끝이 영문이면 L은 '로', M·N은 '으로', 나머지는 '로' (대소문자 같음)", () => {
    expect(toParticle("Hotel")).toBe("로");
    expect(toParticle("CAPITAL")).toBe("로");
    expect(toParticle("Gym")).toBe("으로");
    expect(toParticle("SALON")).toBe("으로");
    expect(toParticle("Pizza Barn")).toBe("으로");
    expect(toParticle("Cafe")).toBe("로");
    expect(toParticle("BHC")).toBe("로");
  });
});

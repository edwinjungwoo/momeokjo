import { describe, expect, it, vi } from "vitest";
import { MAX_RADIUS, MIN_RADIUS, PREWARM_RADIUS, isValidRadius } from "../../shared/constants";
import { DEFAULT_FILTERS } from "../../shared/recommend";
import {
  DEFAULT_SETTINGS, applyShareParams, needsHubPicker, parseSettings, resolveStart, showHubPicker, urlAfterHubChange,
} from "../../shared/settings";
import { isHubId } from "../../shared/hubs";
import { UNREADY_HUB } from "../helpers/unreadyHub";

// R62: 준비 중 동작은 테스트 전용 준비 중 거점으로 본다 (운영 준비 중 거점은 공개되면 바뀐다) — HUBS에 더한다
vi.mock("../../shared/hubs", async (orig) => (await import("../helpers/unreadyHub")).withUnreadyHub(orig));

describe("settings", () => {
  it("R16: 반경은 100~1000m, 50m 단위이고 상한은 Cron 사전 수집 반경과 같다", () => {
    expect([MIN_RADIUS, MAX_RADIUS, PREWARM_RADIUS]).toEqual([100, 1000, 1000]);
    expect([100, 150, 500, 1000].every(isValidRadius)).toBe(true);
    expect([50, 125, 1050, 500.5, Number.NaN].some(isValidRadius)).toBe(false);
  });

  it("R25: 저장값이 없거나 깨졌으면 기본값 (기본 거점 봉은사역)", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("{oops")).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS).toEqual({ filters: DEFAULT_FILTERS, hubId: "bongeunsa" });
  });

  it("R25: 유효한 필드는 살리고 잘못된 필드만 기본값으로", () => {
    const raw = JSON.stringify({
      filters: { ...DEFAULT_FILTERS, party: 4, priceCap: 15000, radius: 99999, sort: "weird" },
      hubId: "ddp",
    });
    const s = parseSettings(raw);
    expect(s.filters.party).toBe(4);
    expect(s.filters.priceCap).toBe(15000);
    expect(s.filters.radius).toBe(DEFAULT_FILTERS.radius);
    expect(s.filters.sort).toBe("distance");
    expect(s.hubId).toBe("ddp");
    expect(parseSettings(JSON.stringify({ filters: { radius: 1001 } })).filters.radius).toBe(500);
    expect(parseSettings(JSON.stringify({ filters: { radius: 850 } })).filters.radius).toBe(850);
    // 50m 단위가 아니면 기본값 (캐시 키를 적게 유지)
    expect(parseSettings(JSON.stringify({ filters: { radius: 825 } })).filters.radius).toBe(500);
  });

  it("R25/R45: 손으로 검증해도 예전(zod) 규칙과 같다 — 모양이 틀린 값은 필드별로, 루트가 틀리면 전체 기본값", () => {
    for (const raw of ["null", "[]", "5", '"x"', "{}"]) expect(parseSettings(raw)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(JSON.stringify({ filters: [], hubId: "ddp" }))).toEqual({ filters: DEFAULT_FILTERS, hubId: "ddp" });
    expect(parseSettings(JSON.stringify({ filters: null, hubId: 3 }))).toEqual(DEFAULT_SETTINGS);
    const s = parseSettings(
      JSON.stringify({
        filters: { radius: "500", party: "2", groups: ["korean", "pizza"], includeBar: 1, priceCap: "10000", minRating: 3, openOnly: "y", sort: 1 },
      }),
    );
    expect(s.filters).toEqual(DEFAULT_FILTERS);
    const ok = parseSettings(
      JSON.stringify({
        filters: { radius: 300, party: 1, groups: ["korean", "etc"], includeBar: true, priceCap: 20000, minRating: 3.5, openOnly: false, sort: "price", x: 1 },
        hubId: "pangyo",
        extra: true,
      }),
    );
    expect(ok).toEqual({
      filters: { radius: 300, party: 1, groups: ["korean", "etc"], includeBar: true, priceCap: 20000, minRating: 3.5, openOnly: false, sort: "price" },
      hubId: "pangyo",
    });
    // 술집(bar)·디저트는 카테고리 칩에 없어서 저장값으로도 받지 않는다
    expect(parseSettings(JSON.stringify({ filters: { groups: ["bar"] } })).filters.groups).toEqual(DEFAULT_FILTERS.groups);
  });

  it("R25: 모르는 거점은 기본 거점으로, 예전 저장값(center, lunch)은 버린다", () => {
    expect(parseSettings(JSON.stringify({ hubId: "atlantis" })).hubId).toBe("bongeunsa");
    const old = parseSettings(JSON.stringify({ filters: { ...DEFAULT_FILTERS, lunch: 30 }, center: { lat: 37.5, lng: 127 } }));
    expect(old).toEqual(DEFAULT_SETTINGS);
    expect(old).not.toHaveProperty("center");
    expect(old.filters).not.toHaveProperty("lunch");
  });

  it("R23/R25: 공유 파라미터(거점, 반경)가 저장값보다 우선한다", () => {
    const s = applyShareParams(DEFAULT_SETTINGS, { placeIds: ["1"], hubId: "ddp", radius: 300 });
    expect(s.hubId).toBe("ddp");
    expect(s.filters.radius).toBe(300);
    expect(applyShareParams(DEFAULT_SETTINGS, { placeIds: [], hubId: null, radius: 850 })).toEqual({
      ...DEFAULT_SETTINGS, filters: { ...DEFAULT_FILTERS, radius: 850 },
    });
    expect(applyShareParams(DEFAULT_SETTINGS, { placeIds: [], hubId: null, radius: null })).toEqual(DEFAULT_SETTINGS);
  });

  it("R25: 공유 파라미터를 적용해도 저장값 객체는 바뀌지 않는다", () => {
    const stored = parseSettings(JSON.stringify({ filters: { ...DEFAULT_FILTERS, party: 4, radius: 700 }, hubId: "pangyo" }));
    const snapshot = structuredClone(stored);
    const s = applyShareParams(stored, { placeIds: ["1"], hubId: "ddp", radius: 300 });
    expect(s).toMatchObject({ hubId: "ddp", filters: { radius: 300, party: 4 } });
    expect(stored).toEqual(snapshot);
    expect(DEFAULT_SETTINGS.filters.radius).toBe(500);
  });

  it("R43/R25: 거점 경로로 열면 그 거점을 쓰고 저장한다 (주소창은 그대로)", () => {
    const stored = JSON.stringify({ ...DEFAULT_SETTINGS, hubId: "ddp" });
    const r = resolveStart(stored, "/pangyo", "");
    expect(r.settings.hubId).toBe("pangyo");
    expect(r.saveHub).toBe("pangyo");
    expect(r.replaceUrl).toBeNull();
    // 공유가 아닌 다른 파라미터만 있으면 지우되 경로는 남긴다
    const q = resolveStart(stored, "/pangyo/", "?r=700");
    expect(q.settings).toMatchObject({ hubId: "pangyo", filters: { radius: 700 } });
    expect(q.saveHub).toBe("pangyo");
    expect(q.replaceUrl).toBe("/pangyo/");
  });

  it("R43/R25: 공유 링크의 거점 경로는 이번에만 쓰고 저장하지 않으며, 주소는 /로 돌린다", () => {
    const stored = JSON.stringify({ ...DEFAULT_SETTINGS, hubId: "pangyo" });
    const r = resolveStart(stored, "/bongeunsa", "?t=1,2&r=700");
    expect(r.settings).toMatchObject({ hubId: "bongeunsa", filters: { radius: 700 } });
    expect(r.share.placeIds).toEqual(["1", "2"]);
    expect(r.saveHub).toBeNull();
    expect(r.replaceUrl).toBe("/");
    // 예전 링크도 같다
    const old = resolveStart(stored, "/", "?t=1&h=ddp&r=300");
    expect(old.settings.hubId).toBe("ddp");
    expect(old.saveHub).toBeNull();
    expect(old.replaceUrl).toBe("/");
  });

  it("R43/R25: 모르는 경로와 파라미터 없는 루트는 저장값 그대로", () => {
    const stored = JSON.stringify({ ...DEFAULT_SETTINGS, hubId: "naebang" });
    expect(resolveStart(stored, "/brand", "")).toMatchObject({ saveHub: null, replaceUrl: null, settings: { hubId: "naebang" } });
    expect(resolveStart(stored, "/", "")).toMatchObject({ saveHub: null, replaceUrl: null, settings: { hubId: "naebang" } });
  });

  it("R43/R25: 거점 경로로 연 뒤 손으로 거점을 바꾸면 주소를 /로 돌린다 (새로고침이 북마크 거점으로 되돌리지 않게)", () => {
    expect(urlAfterHubChange("/ddp")).toBe("/");
    expect(urlAfterHubChange("/pangyo/")).toBe("/");
    // 거점 경로가 아니면 주소를 건드리지 않는다
    expect(urlAfterHubChange("/")).toBeNull();
    expect(urlAfterHubChange("/brand")).toBeNull();
    expect(urlAfterHubChange("/admin")).toBeNull();
  });
  it("R61: 새 기기(저장값 없음)에서 링크 없이 열면 거점을 묻는다", () => {
    expect(needsHubPicker({ stored: null, path: "/", query: "" })).toBe(true);
    // 거점을 정하지 않는 파라미터·모르는 경로·모르는 거점은 링크로 치지 않는다
    expect(needsHubPicker({ stored: null, path: "/", query: "?track=1" })).toBe(true);
    expect(needsHubPicker({ stored: null, path: "/", query: "?r=700" })).toBe(true);
    expect(needsHubPicker({ stored: null, path: "/brand", query: "" })).toBe(true);
    expect(needsHubPicker({ stored: null, path: "/atlantis", query: "" })).toBe(true);
    expect(needsHubPicker({ stored: null, path: "/", query: "?h=atlantis" })).toBe(true);
    expect(needsHubPicker({ stored: null, path: "/", query: "?t=abc" })).toBe(true);
    // 거점이 없는 공유 링크(경로 거점·h 없는 t, 예전 p)도 거점을 정하지 않는다 — 받은 시트를 닫은 뒤 묻는다 (showHubPicker)
    expect(needsHubPicker({ stored: null, path: "/", query: "?t=1" })).toBe(true);
    expect(needsHubPicker({ stored: null, path: "/", query: "?p=12345" })).toBe(true);
    expect(needsHubPicker({ stored: null, path: "/", query: "?t=1,2&r=700" })).toBe(true);
  });

  it("R61: 설정이 저장된 기존 사용자는 묻지 않는다 (예전 저장값·깨진 값 포함 — 저장값이 있으면 고른 것으로 친다)", () => {
    for (const stored of [
      JSON.stringify(DEFAULT_SETTINGS),
      JSON.stringify({ ...DEFAULT_SETTINGS, hubId: "ddp" }),
      JSON.stringify({ filters: { ...DEFAULT_FILTERS, lunch: 30 }, center: { lat: 37.5, lng: 127 } }),
      JSON.stringify({ filters: { radius: 700 } }),
      "{oops",
    ]) {
      expect(needsHubPicker({ stored, path: "/", query: "" }), stored).toBe(false);
    }
    // 설정은 안 바꿨어도 첫 방문 안내를 닫은(뽑기를 해 본) 기기는 기존 사용자다
    expect(needsHubPicker({ stored: null, tipSeen: true, path: "/", query: "" })).toBe(false);
  });

  it("R61: 거점을 정하는 링크(짧은 링크, 거점 경로·h가 있는 공유 링크, 예전 h)로 열면 묻지 않는다", () => {
    for (const [path, query] of [
      ["/pangyo", ""],
      ["/pangyo/", ""],
      ["/ddp", "?t=1,2&r=700"],
      ["/", "?h=naebang"],
      ["/", "?p=12345&h=pangyo"],
      ["/", "?t=1&h=ddp&r=300"],
    ]) {
      expect(needsHubPicker({ stored: null, path, query }), path + query).toBe(false);
    }
  });

  it("R61: 관리 화면(/admin)에서는 묻지 않는다", () => {
    expect(needsHubPicker({ stored: null, path: "/admin", query: "" })).toBe(false);
    expect(needsHubPicker({ stored: null, path: "/admin/", query: "?days=7" })).toBe(false);
  });

  it("R61: 처음 열 때 묻는지(askHub)와, 새 기기에서 링크가 정한 거점은 이 기기의 거점으로 저장한다", () => {
    expect(resolveStart(null, "/", "")).toMatchObject({ askHub: true, saveHub: null, settings: DEFAULT_SETTINGS });
    // 짧은 링크는 원래도 저장한다
    expect(resolveStart(null, "/pangyo", "")).toMatchObject({ askHub: false, saveHub: "pangyo" });
    // 새 기기의 공유 링크: 거점은 저장하고(반경은 이번에만), 주소는 /로
    const share = resolveStart(null, "/ddp", "?t=1,2&r=700");
    expect(share).toMatchObject({ askHub: false, saveHub: "ddp", replaceUrl: "/", settings: { hubId: "ddp", filters: { radius: 700 } } });
    expect(resolveStart(null, "/", "?t=1&h=naebang")).toMatchObject({ askHub: false, saveHub: "naebang" });
    // 거점이 없는 공유 링크는 기본 거점을 저장하지 않고, 받은 시트 뒤에 묻는다
    expect(resolveStart(null, "/", "?p=12345")).toMatchObject({ askHub: true, saveHub: null, replaceUrl: "/" });
    expect(resolveStart(null, "/", "?t=1,2&r=700")).toMatchObject({ askHub: true, saveHub: null, replaceUrl: "/" });
    // 이미 고른 기기(저장값 또는 첫 방문 안내를 닫음)의 공유 링크 거점은 예전처럼 이번에만 (R43)
    const stored = JSON.stringify({ ...DEFAULT_SETTINGS, hubId: "pangyo" });
    expect(resolveStart(stored, "/ddp", "?t=1")).toMatchObject({ askHub: false, saveHub: null });
    expect(resolveStart(null, "/ddp", "?t=1", true)).toMatchObject({ askHub: false, saveHub: null });
    expect(resolveStart(null, "/", "", true)).toMatchObject({ askHub: false, saveHub: null });
    expect(resolveStart(stored, "/", "")).toMatchObject({ askHub: false, saveHub: null });
  });

  it("R62: 준비 중 거점은 모르는 거점처럼 — 저장값은 기본 거점, 짧은 링크·공유 링크의 거점은 무시", () => {
    const id = UNREADY_HUB.id;
    expect(isHubId(id)).toBe(true);
    expect(parseSettings(JSON.stringify({ hubId: id })).hubId).toBe("bongeunsa");
    // 처음 온 기기가 준비 중 거점 경로로 열면 모르는 경로(/brand)처럼: 저장하지 않고 거점을 묻는다
    expect(resolveStart(null, `/${id}`, "")).toEqual(resolveStart(null, "/brand", ""));
    expect(resolveStart(null, `/${id}`, "")).toMatchObject({ askHub: true, saveHub: null, settings: DEFAULT_SETTINGS });
    // 이미 고른 기기는 저장한 거점 그대로
    const stored = JSON.stringify({ ...DEFAULT_SETTINGS, hubId: "naebang" });
    expect(resolveStart(stored, `/${id}/`, "")).toMatchObject({ saveHub: null, replaceUrl: null, settings: { hubId: "naebang" } });
    // 공유 링크의 준비 중 거점(경로·예전 h)도 무시 — 거점 없는 공유 링크처럼 받은 시트 뒤에 묻는다
    expect(resolveStart(null, `/${id}`, "?t=1,2&r=700")).toMatchObject({ askHub: true, saveHub: null, settings: { hubId: "bongeunsa" } });
    expect(resolveStart(stored, "/", `?t=1&h=${id}`)).toMatchObject({ settings: { hubId: "naebang" } });
    expect(needsHubPicker({ stored: null, path: `/${id}`, query: "" })).toBe(true);
  });

  it("R61: 질문을 언제 보이나 — 거점 없는 공유 링크면 받은 곳을 다 불러오고 그 시트를 닫은 뒤에", () => {
    expect(showHubPicker({ askHub: false, shareLink: false, shareSettled: false, sheetOpen: false })).toBe(false);
    expect(showHubPicker({ askHub: true, shareLink: false, shareSettled: false, sheetOpen: false })).toBe(true);
    // 공유 링크: 불러오는 중이거나 받은 시트(3곳·한 곳)가 떠 있으면 아직
    expect(showHubPicker({ askHub: true, shareLink: true, shareSettled: false, sheetOpen: false })).toBe(false);
    expect(showHubPicker({ askHub: true, shareLink: true, shareSettled: true, sheetOpen: true })).toBe(false);
    // 다 불러왔고(못 찾았어도) 시트가 닫혀 있으면 묻는다
    expect(showHubPicker({ askHub: true, shareLink: true, shareSettled: true, sheetOpen: false })).toBe(true);
    expect(showHubPicker({ askHub: false, shareLink: true, shareSettled: true, sheetOpen: false })).toBe(false);
  });
});

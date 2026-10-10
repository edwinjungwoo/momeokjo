import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type FakeScript = { src: string; async: boolean; onload: (() => void) | null; onerror: (() => void) | null; remove: () => void };

/** window.setTimeout·kakao와 document.createElement·head만 흉내 낸다 (타이머는 손으로 부른다) */
function fakeDom() {
  const scripts: FakeScript[] = [];
  const timers: ((() => void) | null)[] = [];
  const win: { kakao?: unknown; setTimeout: (fn: () => void) => number; clearTimeout: (id: number) => void } = {
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: (id) => {
      timers[id - 1] = null;
    },
  };
  const doc = {
    createElement: (): FakeScript => ({ src: "", async: false, onload: null, onerror: null, remove: () => {} }),
    head: { appendChild: (s: FakeScript) => void scripts.push(s) },
  };
  vi.stubGlobal("window", win);
  vi.stubGlobal("document", doc);
  return { win, scripts, fireTimer: (i: number) => timers[i]?.() };
}

const load = async () => (await import("../../web/kakaoLoader")).loadKakaoMaps;

describe("R28 카카오맵 SDK 불러오기", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("R28: script가 뜨고 kakao.maps.load가 부르면 SDK를 돌려주고, 다시 불러도 같은 약속(script는 하나)", async () => {
    const dom = fakeDom();
    const loadKakaoMaps = await load();
    const p = loadKakaoMaps("k");
    expect(loadKakaoMaps("k")).toBe(p);
    expect(dom.scripts).toHaveLength(1);
    expect(dom.scripts[0].src).toBe("https://dapi.kakao.com/v2/maps/sdk.js?appkey=k&autoload=false");
    dom.win.kakao = { maps: { load: (cb: () => void) => cb() } };
    dom.scripts[0].onload!();
    await expect(p).resolves.toBe(dom.win.kakao);
  });

  it("R28: 시간 초과로 실패한 뒤 다시 불렀으면, 옛 script의 늦은 실패·성공이 새 로드를 지우거나 끝내지 않는다", async () => {
    const dom = fakeDom();
    const loadKakaoMaps = await load();
    const first = loadKakaoMaps("k");
    dom.fireTimer(0); // 10초 초과
    await expect(first).rejects.toThrow("시간 초과");
    const second = loadKakaoMaps("k");
    expect(second).not.toBe(first);
    expect(dom.scripts).toHaveLength(2);
    // 옛 script가 이제야 실패한다 — 진행 중인 새 로드는 그대로 (script를 또 붙이지 않는다)
    dom.scripts[0].onerror!();
    expect(loadKakaoMaps("k")).toBe(second);
    expect(dom.scripts).toHaveLength(2);
    // 새 script가 뜨면 새 로드가 끝난다
    dom.win.kakao = { maps: { load: (cb: () => void) => cb() } };
    dom.scripts[1].onload!();
    await expect(second).resolves.toBe(dom.win.kakao);
    expect(loadKakaoMaps("k")).toBe(second);
  });

  it("R28: 로드가 끝난 뒤에 늦게 온 실패 신호(onerror)는 다음 호출이 새로 불러오게 만들지 않는다", async () => {
    const dom = fakeDom();
    const loadKakaoMaps = await load();
    const p = loadKakaoMaps("k");
    dom.win.kakao = { maps: { load: (cb: () => void) => cb() } };
    dom.scripts[0].onload!();
    await p;
    dom.scripts[0].onerror!();
    expect(loadKakaoMaps("k")).toBe(p);
    expect(dom.scripts).toHaveLength(1);
  });
});

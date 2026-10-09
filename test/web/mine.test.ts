import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MineSections } from "../../shared/mine";
import { HeartButton } from "../../web/components/HeartButton";
import { MineButton, MineSheet } from "../../web/components/MineSheet";
import { PlaceCard } from "../../web/components/PlaceCard";
import { TrioSheet } from "../../web/components/TrioSheet";
import { apiPlace } from "../helpers/apiPlace";

const POS = { lat: 37.514, lng: 127.06 };
const FULL: MineSections = {
  favorites: [{ id: "1", name: "중앙해장", line: "해장국 · 봉은사역 근처", pos: POS }],
  recent: [{ id: "2", name: "만리장성", line: "중국요리 · 삼성역 근처", pos: POS }],
  excluded: [{ id: "3", name: "이전에 뺀 가게", line: "", pos: null }],
};
const noop = () => {};
const sheet = (sections: MineSections) =>
  renderToStaticMarkup(createElement(MineSheet, { sections, onOpen: noop, onToggleFavorite: noop, onRestore: noop, onClose: noop }));
/** 묶음 제목부터 다음 묶음 제목 전까지 */
const section = (html: string, title: string) => {
  const start = html.indexOf(`>${title}</h3>`);
  expect(start, title).toBeGreaterThan(-1);
  const next = html.indexOf("</h3>", start + title.length + 6);
  return html.slice(start, next === -1 ? undefined : next);
};

describe("R65 내 가게 — 화면", () => {
  it("R65: 하트 버튼 — 즐겨찾기가 아니면 빈 하트 '즐겨찾기에 넣기', 즐겨찾기면 '즐겨찾기에서 빼기' (aria-pressed)", () => {
    const off = renderToStaticMarkup(createElement(HeartButton, { on: false, onToggle: noop }));
    expect(off).toContain('aria-label="즐겨찾기에 넣기"');
    expect(off).toContain('aria-pressed="false"');
    expect(off).not.toContain("is-on");
    const on = renderToStaticMarkup(createElement(HeartButton, { on: true, onToggle: noop }));
    expect(on).toContain('aria-label="즐겨찾기에서 빼기"');
    expect(on).toContain('aria-pressed="true"');
    expect(on).toContain("is-on");
  });

  it("R65: 목록·핀 카드 제목 옆에 하트 (행동 줄은 그대로 공유·카카오맵)", () => {
    const props = { place: apiPlace("7", { name: "중앙해장" }), topPercent: undefined, now: new Date(), onClose: noop, onShare: noop, onKakao: noop, onFavorite: noop };
    const off = renderToStaticMarkup(createElement(PlaceCard, { ...props, favorite: false }));
    expect(off).toContain('aria-label="즐겨찾기에 넣기"');
    const head = off.slice(off.indexOf('class="card-head"'), off.indexOf('class="sheet-foot"'));
    expect(head).toContain("heart");
    const foot = off.slice(off.indexOf('class="sheet-foot"'));
    expect(foot).not.toContain("heart");
    expect(renderToStaticMarkup(createElement(PlaceCard, { ...props, favorite: true }))).toContain('aria-label="즐겨찾기에서 빼기"');
  });

  it("R65: 결과 카드는 펼쳤을 때 이름 바로 아래 줄 끝에 하트 (접힌 카드 줄은 그대로)", () => {
    const places = [apiPlace("1"), apiPlace("2"), apiPlace("3")];
    const html = renderToStaticMarkup(
      createElement(TrioSheet, {
        slotName: null, places, received: false, focusId: "2", detailLoading: false, ranks: new Map(), reasons: [null, null, null],
        party: 1, now: new Date(), drawLabel: "다시 뽑기", onDraw: noop, onFocus: noop, onClose: noop, onShare: noop,
        onConfirm: noop, onKakao: noop, onExclude: noop, infoOpen: false, onInfo: noop,
        isFavorite: (id: string) => id === "2", onFavorite: noop,
      }),
    );
    expect(html.match(/class="heart/g)).toHaveLength(1);
    expect(html).toContain('aria-label="즐겨찾기에서 빼기"');
    const detail = html.slice(html.indexOf('class="trio-detail"'));
    expect(detail.indexOf("heart")).toBeLessThan(detail.indexOf('class="trio-links"'));
  });

  it("R65: 헤더의 '내 가게' 버튼 — 하트 아이콘, 읽기 이름 '내 가게'", () => {
    const html = renderToStaticMarkup(createElement(MineButton, { onClick: noop }));
    expect(html).toContain('aria-label="내 가게"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("<svg");
  });

  it("R65: 내 가게 시트 — 제목, 즐겨찾기·최근 열어 본 곳(설명 한 줄)·뺀 곳 세 묶음", () => {
    const html = sheet(FULL);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain(">내 가게</h2>");
    const titles = ["즐겨찾기", "최근 열어 본 곳", "뺀 곳"].map((t) => html.indexOf(`>${t}</h3>`));
    expect(titles.every((i) => i > -1)).toBe(true);
    expect([...titles].sort((a, b) => a - b)).toEqual(titles);

    const fav = section(html, "즐겨찾기");
    expect(fav).toContain("중앙해장");
    expect(fav).toContain("해장국 · 봉은사역 근처");
    expect(fav).toContain('aria-label="즐겨찾기에서 빼기"');

    const recent = section(html, "최근 열어 본 곳");
    expect(recent).toContain("카카오맵을 열었거나 공유한 곳이에요");
    expect(recent).toContain("만리장성");
    expect(recent).toContain('aria-label="즐겨찾기에 넣기"');

    const out = section(html, "뺀 곳");
    expect(out).toContain("이전에 뺀 가게");
    expect(out).toContain(">다시 보기</button>");
    expect(out).not.toContain("heart");
    expect(html).not.toContain("아직 모은 가게가 없어요");
  });

  it("R65: 빈 묶음은 숨긴다", () => {
    const html = sheet({ ...FULL, recent: [], excluded: [] });
    expect(html).toContain(">즐겨찾기</h3>");
    expect(html).not.toContain("최근 열어 본 곳");
    expect(html).not.toContain(">뺀 곳</h3>");
    const onlyOut = sheet({ favorites: [], recent: [], excluded: FULL.excluded });
    expect(onlyOut).not.toContain(">즐겨찾기</h3>");
    expect(onlyOut).toContain(">뺀 곳</h3>");
  });

  it("R65: 모은 가게가 하나도 없으면 마스코트와 안내 두 줄", () => {
    const html = sheet({ favorites: [], recent: [], excluded: [] });
    expect(html).toContain("아직 모은 가게가 없어요");
    expect(html).toContain("카드의 ♡를 누르면 여기 모여요");
    expect(html).toContain('class="mascot');
    expect(html).not.toContain("</h3>");
  });
});

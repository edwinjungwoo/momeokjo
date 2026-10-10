type Focusable = { isConnected: boolean; focus(options?: FocusOptions): void };

/**
 * 시트·카드가 닫힐 때 초점을 돌려준다: 닫혀서 초점이 갈 곳을 잃었으면(body·없음) 연 요소로, 그 요소가 없어졌거나 body면
 * fallback(예: 뽑기 버튼)으로. 사용자가 이미 다른 곳을 눌러 초점이 거기 있으면 옮기지 않는다 (키보드·스크린리더가 문서 맨 위로 가지 않게)
 */
export function restoreFocus(
  doc: Pick<Document, "activeElement" | "body">, opener: Element | null, fallback?: () => Focusable | null,
): void {
  const active = doc.activeElement;
  if (active && active !== doc.body) return;
  const o = opener as unknown as Focusable | null;
  const target = o && opener !== doc.body && o.isConnected && typeof o.focus === "function" ? o : (fallback?.() ?? null);
  target?.focus({ preventScroll: true });
}

/** 열 때 초점이 있던 요소 (서버 렌더·테스트에는 document가 없다) */
export const focusedNow = (): Element | null => (typeof document === "undefined" ? null : document.activeElement);

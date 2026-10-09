import { lastLevel } from "./category";
import { isValidRadius } from "./constants";
import { isPublicHubId, publicHubById } from "./hubs";
import type { Filters } from "./recommend";
import type { ApiPlace } from "./types";

const PLACE_ID = /^\d{1,15}$/;
const MAX_SHARED = 3;

/** R23′/R43: /{거점 id}?t={id1},{id2},{id3}&r={반경}. id는 숫자, 거점 id는 URL에 안전한 글자라 쉼표를 그대로 둔다 */
export function shareUrl(origin: string, ids: string[], hubId: string, radius: number): string {
  const base = new URL(`/${encodeURIComponent(hubId)}`, origin).toString();
  return `${base}?t=${ids.join(",")}&r=${radius}`;
}

/** R43: 경로가 정확히 /{거점 id}(끝 / 허용)이면 그 거점 id, 아니면 null. R62: 준비 중 거점은 모르는 경로처럼 null */
export function parseHubPath(pathname: string): string | null {
  const m = /^\/([a-z0-9-]+)\/?$/.exec(pathname);
  return m && isPublicHubId(m[1]) ? m[1] : null;
}

/** R36: 관리 화면 경로 — /admin과 /admin/(끝 슬래시) */
export const isAdminPath = (pathname: string): boolean => pathname === "/admin" || pathname === "/admin/";

function line(p: ApiPlace, i: number): string {
  const rating = p.detail?.rating;
  return [
    `${i + 1}. ${p.name}`,
    lastLevel(p.category) || null,
    rating !== null && rating !== undefined ? `★${rating.toFixed(1)}` : null,
    p.walkMinutes !== undefined ? `도보 ${p.walkMinutes}분` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** R23′: 뽑힌 후보(최대 3곳)를 한 번에 제안하는 공유 문구 */
export function shareText(places: ApiPlace[], f: Filters, hubId: string, origin: string): string {
  const who = f.party === 4 ? "4명+" : `${f.party}명`;
  const ask = places.length === 1 ? "여기 어때요?" : "이 중에 어디 갈래요?";
  return [
    `🍚 점심 고? (${who} · ${publicHubById(hubId).name} 반경 ${f.radius}m)`,
    ...places.map(line),
    `${ask} 👉 ${shareUrl(origin, places.map((p) => p.id), hubId, f.radius)}`,
  ].join("\n");
}

/** 끝소리의 받침: 없음 / ㄹ / 그 밖의 받침 */
type Final = "none" | "rieul" | "other";
/** 끝 숫자를 읽는 소리(영 일 이 삼 사 오 육 칠 팔 구)의 받침 — 영·삼·육은 ㅇ·ㅁ·ㄱ, 일·칠·팔은 ㄹ */
const DIGIT_FINAL: Record<string, Final> = { 0: "other", 1: "rieul", 3: "other", 6: "other", 7: "rieul", 8: "rieul" };
/** 끝 영문자를 읽는 소리의 받침 — 엠·엔은 ㅁ·ㄴ, 엘·알은 ㄹ */
const LATIN_FINAL: Record<string, Final> = { m: "other", n: "other", l: "rieul", r: "rieul" };

/**
 * 이름의 끝소리 받침. 끝에서부터 첫 글자(한글·영문·숫자)를 보고, 그 글자(숫자·영문은 읽는 소리)의 받침을 돌려준다.
 * 괄호·공백 같은 기호는 건너뛴다 ("중앙해장(본점)" → 점 → "other"). 읽을 글자가 없으면 "none".
 */
function finalOf(name: string): Final {
  for (let i = name.length - 1; i >= 0; i--) {
    const ch = name[i];
    const code = name.charCodeAt(i);
    if (code >= 0xac00 && code <= 0xd7a3) {
      const jong = (code - 0xac00) % 28;
      return jong === 0 ? "none" : jong === 8 ? "rieul" : "other";
    }
    if (/[0-9]/.test(ch)) return DIGIT_FINAL[ch] ?? "none";
    if (/[A-Za-z]/.test(ch)) return LATIN_FINAL[ch.toLowerCase()] ?? "none";
  }
  return "none";
}

/**
 * R47: 이름 뒤 조사 "(으)로" — ㄹ이 아닌 받침이 있으면 "으로", 없거나 ㄹ이면 "로".
 * 숫자: 0 영·3 삼·6 육 → "으로", 나머지(1 일·7 칠·8 팔은 ㄹ) → "로". 영문: M·N → "으로", 나머지(L 엘 포함) → "로".
 */
export function toParticle(name: string): "으로" | "로" {
  return finalOf(name) === "other" ? "으로" : "로";
}

/**
 * R37: 이름 뒤 조사 "은/는" — ㄹ을 포함해 받침이 있으면 "은", 없으면 "는".
 * 숫자: 0 영·1 일·3 삼·6 육·7 칠·8 팔 → "은", 2 이·4 사·5 오·9 구 → "는". 영문: L 엘·M 엠·N 엔·R 알 → "은", 나머지 → "는".
 */
export function topicParticle(name: string): "은" | "는" {
  return finalOf(name) === "none" ? "는" : "은";
}

/** R37: "다음부터 안 보기"를 누른 뒤 되돌리기와 함께 띄우는 알림 문구 */
export const excludeToastText = (name: string): string => `${name}${topicParticle(name)} 다음부터 안 뽑아요`;

/** R65: 이름 뒤 조사 "을/를" — ㄹ을 포함해 받침이 있으면 "을", 없으면 "를" (숫자·영문은 읽는 소리, topicParticle과 같은 규칙) */
export function objectParticle(name: string): "을" | "를" {
  return finalOf(name) === "none" ? "를" : "을";
}

/** R65: "내 가게"의 뺀 곳에서 "다시 보기"를 누른 뒤 알림 문구 */
export const restoreToastText = (name: string): string => `${name}${objectParticle(name)} 다시 뽑아요`;

/** R47: 펼친 결과 카드의 "여기로 가자고 공유" — 한 곳을 확정해서 보내는 문구 (카카오맵 링크 + 그 한 곳의 공유 링크) */
export function shareConfirmText(p: ApiPlace, hubId: string, radius: number, origin: string): string {
  const walk = p.walkMinutes !== undefined ? ` 도보 ${p.walkMinutes}분` : "";
  return [`👉 ${p.name}${toParticle(p.name)} 가요!${walk}`, p.url, shareUrl(origin, [p.id], hubId, radius)].join("\n");
}

export type ShareParams = { placeIds: string[]; hubId: string | null; radius: number | null };

/**
 * t(쉼표로 이은 id 1~3개)를 읽고, 없으면 예전 p(1개)를 읽는다. 예전 링크의 lat/lng는 무시한다.
 * 거점은 경로(R43)가 우선이고, 없으면 예전 h를 읽는다. R62: 준비 중 거점(경로·h)은 모르는 거점처럼 버린다.
 */
export function parseShareParams(search: string, pathname = "/"): ShareParams {
  const q = new URLSearchParams(search);
  const fromT = [...new Set((q.get("t") ?? "").split(",").filter((id) => PLACE_ID.test(id)))].slice(0, MAX_SHARED);
  const p = q.get("p");
  const h = q.get("h");
  const r = Number(q.get("r"));
  return {
    placeIds: fromT.length > 0 ? fromT : p && PLACE_ID.test(p) ? [p] : [],
    hubId: parseHubPath(pathname) ?? (isPublicHubId(h) ? h : null),
    radius: q.has("r") && isValidRadius(r) ? r : null,
  };
}

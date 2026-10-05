/** "scheme://" 뒤 authority 부분 (URL 파서는 기본 포트 ":443"을 지워버려서 원문에서 본다) */
const authorityOf = (raw: string) => /^[a-z][a-z0-9+.-]*:\/\/([^/?#\\]*)/i.exec(raw.trim())?.[1] ?? "";

/** 카카오 CDN 사진만 쓴다 (외부 블로그 이미지는 다른 사이트에서 불러오면 막힌다). http/https만, 사용자 정보·포트 지정은 거부 */
export function kakaoPhotoUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (u.username || u.password || u.port) return null;
    const authority = authorityOf(raw);
    if (authority.includes("@") || authority.includes(":")) return null;
    if (u.hostname !== "kakaocdn.net" && !u.hostname.endsWith(".kakaocdn.net")) return null;
    u.protocol = "https:";
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * R45: 썸네일 서버가 WebP로 바꿔 준다(`.fwebp` 다음에 `.q70`을 붙여야 품질이 WebP에 적용된다).
 * 원본이 PNG인 가게가 많아서 예전 C320x320.q50은 장당 200KB, R640x0.q50은 1MB를 넘었다.
 */
const THUMB = "https://img1.kakaocdn.net/cthumb/local";

/** 목록(64px)·결과 카드(56px) 썸네일: 허용 크기 중 64px의 2배인 128 */
export function photoThumbUrl(url: string): string {
  return `${THUMB}/C128x128.fwebp.q70/?fname=${encodeURIComponent(url)}`;
}

/** 카드 상단 사진용: 가로 640 기준으로 비율 유지 리사이즈 */
export function photoWideUrl(url: string): string {
  return `${THUMB}/R640x0.fwebp.q70/?fname=${encodeURIComponent(url)}`;
}

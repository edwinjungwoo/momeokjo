/** 카카오 CDN 사진만 쓴다 (외부 블로그 이미지는 다른 사이트에서 불러오면 막힌다) */
export function kakaoPhotoUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.hostname !== "kakaocdn.net" && !u.hostname.endsWith(".kakaocdn.net")) return null;
    u.protocol = "https:";
    return u.toString();
  } catch {
    return null;
  }
}

export function photoThumbUrl(url: string, px: number): string {
  return `https://img1.kakaocdn.net/cthumb/local/C${px}x${px}.q50/?fname=${encodeURIComponent(url)}`;
}

/** 카드 상단 사진용: 가로 640 기준으로 비율 유지 리사이즈 */
export function photoWideUrl(url: string): string {
  return `https://img1.kakaocdn.net/cthumb/local/R640x0.q50/?fname=${encodeURIComponent(url)}`;
}

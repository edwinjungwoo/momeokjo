import { describe, expect, it } from "vitest";
import { kakaoPhotoUrl, photoThumbUrl, photoWideUrl } from "../../shared/photo";

describe("photo", () => {
  it("R33: 카카오 CDN 사진만 받아들이고 https로 바꾼다", () => {
    expect(kakaoPhotoUrl("http://t1.kakaocdn.net/fiy_reboot/place/B6D1")).toBe("https://t1.kakaocdn.net/fiy_reboot/place/B6D1");
    expect(kakaoPhotoUrl("https://t1.kakaocdn.net/a?original")).toBe("https://t1.kakaocdn.net/a?original");
  });
  it("R33: 네이버 블로그 등 다른 호스트, 빈 값, 깨진 URL은 null", () => {
    expect(kakaoPhotoUrl("https://postfiles.pstatic.net/x.JPG?type=w773")).toBeNull();
    expect(kakaoPhotoUrl("https://evilkakaocdn.net.example.com/x")).toBeNull();
    expect(kakaoPhotoUrl("")).toBeNull();
    expect(kakaoPhotoUrl(null)).toBeNull();
    expect(kakaoPhotoUrl("not a url")).toBeNull();
  });
  it("R33: 썸네일은 카카오 썸네일 서버를 거친다", () => {
    expect(photoThumbUrl("https://t1.kakaocdn.net/a?original", 320)).toBe(
      "https://img1.kakaocdn.net/cthumb/local/C320x320.q50/?fname=https%3A%2F%2Ft1.kakaocdn.net%2Fa%3Foriginal",
    );
  });
  it("R33: 카드용 사진은 가로 640 리사이즈", () => {
    expect(photoWideUrl("https://t1.kakaocdn.net/a?original")).toBe(
      "https://img1.kakaocdn.net/cthumb/local/R640x0.q50/?fname=https%3A%2F%2Ft1.kakaocdn.net%2Fa%3Foriginal",
    );
  });
});

import { describe, expect, it } from "vitest";
import { kakaoPhotoUrl, photoThumbUrl, photoWideUrl } from "../../shared/photo";

describe("photo", () => {
  it("R33: 카카오 CDN 사진만 받아들이고 https로 바꾼다", () => {
    expect(kakaoPhotoUrl("http://t1.kakaocdn.net/fiy_reboot/place/B6D1")).toBe("https://t1.kakaocdn.net/fiy_reboot/place/B6D1");
    expect(kakaoPhotoUrl("https://t1.kakaocdn.net/a?original")).toBe("https://t1.kakaocdn.net/a?original");
    // 하위 도메인 없는 apex도 카카오 CDN이다. 비슷한 이름의 다른 도메인은 아니다
    expect(kakaoPhotoUrl("http://kakaocdn.net/a")).toBe("https://kakaocdn.net/a");
    expect(kakaoPhotoUrl("https://kakaocdn.net.evil.example/a")).toBeNull();
    expect(kakaoPhotoUrl("https://notkakaocdn.net/a")).toBeNull();
  });
  it("R33: 네이버 블로그 등 다른 호스트, 빈 값, 깨진 URL은 null", () => {
    expect(kakaoPhotoUrl("https://postfiles.pstatic.net/x.JPG?type=w773")).toBeNull();
    expect(kakaoPhotoUrl("https://evilkakaocdn.net.example.com/x")).toBeNull();
    expect(kakaoPhotoUrl("")).toBeNull();
    expect(kakaoPhotoUrl(null)).toBeNull();
    expect(kakaoPhotoUrl("not a url")).toBeNull();
  });
  it("R33: http/https 외 프로토콜, 사용자 정보, 명시적 포트는 거부한다", () => {
    expect(kakaoPhotoUrl("ftp://t1.kakaocdn.net/a")).toBeNull();
    expect(kakaoPhotoUrl("javascript://t1.kakaocdn.net/%0aalert(1)")).toBeNull();
    expect(kakaoPhotoUrl("https://user:pw@t1.kakaocdn.net/a")).toBeNull();
    expect(kakaoPhotoUrl("https://user@t1.kakaocdn.net/a")).toBeNull();
    expect(kakaoPhotoUrl("https://t1.kakaocdn.net:8443/a")).toBeNull();
    expect(kakaoPhotoUrl("http://t1.kakaocdn.net:80/a")).toBeNull();
  });
  it("R33/R45: 썸네일은 카카오 썸네일 서버에서 128px(64px 칸의 2배) WebP q70으로 받는다", () => {
    // 썸네일 서버가 허용하는 크기는 정해져 있다 (120·128·160·200·320 등, 112·144·256은 403). 원본이 PNG면 C320은 200KB가 넘는다
    expect(photoThumbUrl("https://t1.kakaocdn.net/a?original")).toBe(
      "https://img1.kakaocdn.net/cthumb/local/C128x128.fwebp.q70/?fname=https%3A%2F%2Ft1.kakaocdn.net%2Fa%3Foriginal",
    );
  });
  it("R33/R45: 카드용 사진은 가로 640 리사이즈, WebP q70 (원본 PNG 1.3MB → 70KB 안팎)", () => {
    expect(photoWideUrl("https://t1.kakaocdn.net/a?original")).toBe(
      "https://img1.kakaocdn.net/cthumb/local/R640x0.fwebp.q70/?fname=https%3A%2F%2Ft1.kakaocdn.net%2Fa%3Foriginal",
    );
  });
});

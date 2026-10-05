import { describe, expect, it } from "vitest";
import { isOpenDuring, kstParts, parseHours, type RawDay } from "../../shared/hours";
import matsugaze from "../fixtures/place-detail/12101050-matsugaze.json";
import ontable from "../fixtures/place-detail/2179756-ontable.json";
import suda from "../fixtures/place-detail/14480921-suda-bar.json";
import seongbuk from "../fixtures/place-detail/16084885-seongbuk-cheonggukjang.json";
import haidilao from "../fixtures/place-detail/576159166-haidilao.json";
import jungang from "../fixtures/place-detail/27531028-jungang-haejang.json";
import samsung from "../fixtures/place-detail/63388502-samsung-chicken.json";

const daysOf = (fixture: unknown): RawDay[] =>
  ((fixture as any).open_hours.week_from_today.week_periods as any[]).flatMap((p) => p.days);
const kst = (iso: string) => new Date(`${iso}+09:00`);

describe("parseHours", () => {
  it("R8: 브레이크타임은 구간을 나눈다 (마쯔가제 월요일 11:30~22:00, 14:30~18:00 휴식)", () => {
    const h = parseHours(daysOf(matsugaze))!;
    expect(h[1]).toEqual([[690, 870], [1080, 1320]]);
  });

  it("R8: 브레이크타임이 두 번이면 세 구간 (온테이블)", () => {
    const h = parseHours(daysOf(ontable))!;
    expect(h[1]).toEqual([[390, 600], [720, 870], [1080, 1320]]);
  });

  it("R8: 자정을 넘기면 close > 1440 (수다 금요일 16:00~03:00)", () => {
    const h = parseHours(daysOf(suda))!;
    expect(h[5]).toEqual([[960, 1620]]);
  });

  it("R8: 휴무일은 'closed' (성북동청국장 일요일)", () => {
    const h = parseHours(daysOf(seongbuk))!;
    expect(h[0]).toBe("closed");
    expect(h[6]).toEqual([[680, 900], [1020, 1260]]);
  });

  it("R8: 00:00~24:00은 하루 종일, 11:00~24:00은 [660, 1440] (중앙해장)", () => {
    const h = parseHours(daysOf(jungang))!;
    expect(h[1]).toEqual([[660, 1440]]);
    expect(h[2]).toEqual([[0, 1440]]);
  });

  it("R8: 일곱 요일이 모두 채워진다", () => {
    expect(Object.keys(parseHours(daysOf(haidilao))!).sort()).toEqual(["0", "1", "2", "3", "4", "5", "6"]);
  });

  it("R8: 파싱할 수 없으면 null", () => {
    expect(parseHours(null)).toBeNull();
    expect(parseHours([])).toBeNull();
    expect(parseHours([{ day_of_the_week_desc: "월(10/5)", on_days: { start_end_time_desc: "매일 문의" } }])).toBeNull();
    expect(parseHours([{ day_of_the_week_desc: "?", on_days: { start_end_time_desc: "11:00 ~ 22:00" } }])).toBeNull();
  });
});

describe("isOpenDuring", () => {
  it("infra: kstParts는 KST 요일과 분을 돌려준다", () => {
    expect(kstParts(kst("2026-10-05T12:00:00"))).toEqual({ dow: 1, minute: 720 });
    expect(kstParts(kst("2026-10-06T00:10:00"))).toEqual({ dow: 2, minute: 10 });
  });

  const matsu = parseHours(daysOf(matsugaze));

  it("R17: 월요일 12:00 + 30분 동안 영업 중이면 true", () => {
    expect(isOpenDuring(matsu, kst("2026-10-05T12:00:00"))).toBe(true);
  });

  it("R17: 30분 안에 브레이크타임이 시작되면 false (14:20)", () => {
    expect(isOpenDuring(matsu, kst("2026-10-05T14:20:00"))).toBe(false);
  });

  it("R17: 브레이크타임 중이면 false (15:00)", () => {
    expect(isOpenDuring(matsu, kst("2026-10-05T15:00:00"))).toBe(false);
  });

  it("R17: 휴무일이면 false (성북동청국장 일요일 12:00)", () => {
    expect(isOpenDuring(parseHours(daysOf(seongbuk)), kst("2026-10-11T12:00:00"))).toBe(false);
  });

  it("R17: 전날 밤부터 이어진 영업도 인정한다 (하이디라오 화요일 02:00)", () => {
    expect(isOpenDuring(parseHours(daysOf(haidilao)), kst("2026-10-06T02:00:00"))).toBe(true);
    expect(isOpenDuring(parseHours(daysOf(haidilao)), kst("2026-10-06T02:40:00"))).toBe(false);
  });

  it("R17: 영업시간 정보가 없으면 null", () => {
    expect(isOpenDuring(null, kst("2026-10-05T12:00:00"))).toBeNull();
    expect(isOpenDuring({}, kst("2026-10-05T12:00:00"))).toBeNull();
  });

  it("R17: 자정에서 다음 날로 이어지는 영업은 끊기지 않는다 (중앙해장 화요일 23:45, 월요일 23:45)", () => {
    const h = parseHours(daysOf(jungang));
    expect(isOpenDuring(h, kst("2026-10-06T23:45:00"))).toBe(true);
    expect(isOpenDuring(h, kst("2026-10-05T23:45:00"))).toBe(true);
  });

  it("R17: 다음 날이 휴무면 자정에서 끝난다 (삼성치킨 토요일 23:45)", () => {
    const h = parseHours(daysOf(samsung));
    expect(isOpenDuring(h, kst("2026-10-10T23:45:00"))).toBe(false);
    expect(isOpenDuring(h, kst("2026-10-10T23:00:00"))).toBe(true);
  });

  it("R17: 브레이크 시작 시각에 딱 맞춰 끝나면 영업 중 (마쯔가제 14:00)", () => {
    expect(isOpenDuring(matsu, kst("2026-10-05T14:00:00"))).toBe(true);
  });

  it("R17: 오늘 요일 정보가 없으면 null", () => {
    expect(isOpenDuring({ 1: [[660, 1320]] }, kst("2026-10-06T12:00:00"))).toBeNull();
  });
});

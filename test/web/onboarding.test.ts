import { describe, expect, it } from "vitest";
import { trackHubPicked, type OnboardingTracker } from "../../web/onboarding";

function fake() {
  const calls: unknown[][] = [];
  const t: OnboardingTracker = {
    setHub: (id) => calls.push(["setHub", id]),
    start: (id, props) => calls.push(["start", id, props]),
    track: (type, opts) => calls.push(["track", type, opts]),
  };
  return { t, calls };
}

describe("R61 첫 접속 거점 고르기 이벤트", () => {
  it("R61: 세션을 아직 시작하지 않았으면 고른 거점으로 app_open(start)부터, 그다음 hub_change{onboarding: true}", () => {
    const { t, calls } = fake();
    trackHubPicked("pangyo", { radius: 500, party: 2 }, false, t);
    expect(calls).toEqual([
      ["setHub", "pangyo"],
      ["start", "pangyo", { radius: 500, party: 2 }],
      ["track", "hub_change", { props: { onboarding: true } }],
    ]);
  });

  it("R61: 이미 시작한 세션(거점 없는 공유 링크로 연 뒤 묻는 경우)은 app_open 없이 hub_change만", () => {
    const { t, calls } = fake();
    trackHubPicked("ddp", { radius: 500, party: 2 }, true, t);
    expect(calls).toEqual([
      ["setHub", "ddp"],
      ["track", "hub_change", { props: { onboarding: true } }],
    ]);
  });
});

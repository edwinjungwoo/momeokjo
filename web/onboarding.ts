import type { EventType } from "../shared/eventCore";
import type { EventProps } from "../shared/events";
import { setTrackingHub, startTracking, track } from "./analytics";

export type OnboardingTracker = {
  setHub: (hubId: string) => void;
  start: (hubId: string, props?: EventProps) => void;
  track: (t: Exclude<EventType, "app_open">, opts?: { props?: EventProps }) => void;
};
const real: OnboardingTracker = { setHub: setTrackingHub, start: startTracking, track };

/**
 * R61: 첫 접속 질문에서 거점을 고른 뒤의 이벤트. 세션을 아직 시작하지 않았으면(started false) 고른 거점으로 app_open부터 —
 * track()은 거점이 정해지기 전에는 아무것도 보내지 않아서 순서가 바뀌면 hub_change가 버려진다. 그다음 hub_change{onboarding: true}
 */
export function trackHubPicked(hubId: string, props: EventProps, started: boolean, t: OnboardingTracker = real): void {
  t.setHub(hubId);
  if (!started) t.start(hubId, props);
  t.track("hub_change", { props: { onboarding: true } });
}

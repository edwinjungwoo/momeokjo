import { HeartIcon } from "./Icons";

/**
 * R65: 즐겨찾기 ♡ (누르는 영역 44px). 빈 하트 = 즐겨찾기 아님, 찬 포인트색 하트 = 즐겨찾기.
 * 결과 카드·목록/핀 카드·내 가게 시트가 같은 버튼을 쓴다
 */
export function HeartButton({ on, onToggle, className }: { on: boolean; onToggle: () => void; className?: string }) {
  return (
    <button
      type="button"
      className={`heart${on ? " is-on" : ""}${className ? ` ${className}` : ""}`}
      aria-label={on ? "즐겨찾기에서 빼기" : "즐겨찾기에 넣기"}
      aria-pressed={on}
      onClick={onToggle}
    >
      <HeartIcon size={22} filled={on} />
    </button>
  );
}

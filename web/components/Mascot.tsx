/** 브랜드 v2 스티커 포즈 (public/brand/pose/*.png, 투명 배경). 값은 원본 픽셀 크기 — 비율 계산용 */
const POSES = {
  search: [194, 231],
  thumbsup: [204, 198],
  sad: [164, 199],
  waiting: [182, 198],
  warning: [196, 202],
  love: [196, 198],
  conditions: [207, 195],
  location: [200, 248],
} as const;

export type Pose = keyof typeof POSES;

export const poseSrc = (pose: Pose) => `/brand/pose/${pose}.png`;

type Props = {
  pose: Pose;
  /** 표시 높이(px). 너비는 원본 비율로 정한다 */
  height: number;
  className?: string;
  /** 화면에 뜨자마자 보이는 자리면 true (lazy 로딩 안 함) */
  eager?: boolean;
};

/** R30: 장식용 마스코트. 스크린리더에는 읽히지 않는다 */
export function Mascot({ pose, height, className, eager }: Props) {
  const [w, h] = POSES[pose];
  return (
    <img
      className={`mascot${className ? ` ${className}` : ""}`}
      src={poseSrc(pose)}
      alt=""
      aria-hidden="true"
      width={Math.round((height * w) / h)}
      height={height}
      loading={eager ? undefined : "lazy"}
      decoding="async"
      draggable={false}
    />
  );
}

/** 뽑기·공유처럼 누른 뒤에 뜨는 포즈를 미리 받아둬서 깜빡이지 않게 한다 */
export function warmPoses(poses: Pose[]) {
  for (const p of poses) {
    const img = new Image();
    img.decoding = "async";
    img.src = poseSrc(p);
  }
}

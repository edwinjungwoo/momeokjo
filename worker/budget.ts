/** 한 번의 실행에서 쓸 수 있는 외부 호출 횟수 (무료 플랜 50회 한도 보호) */
export class Budget {
  #left: number;
  constructor(n: number) {
    this.#left = Math.max(0, Math.floor(n));
  }
  take(): boolean {
    if (this.#left <= 0) return false;
    this.#left -= 1;
    return true;
  }
  get left(): number {
    return this.#left;
  }
}

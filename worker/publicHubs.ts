import { HUBS, hasCandidateHubs, setPublishedHubIds } from "../shared/hubs";
import { metaKeysStmt } from "./d1Usage";

/**
 * R68 공개 후보(`ready: false`)의 공개 기록: meta `hub_public:{id}` = PublishRecord (JSON).
 * state "public"이면 공개, "hidden"이면 관리자가 공개를 취소한 것 — 본 Cron이 다시 자동 공개하지 않는다(관리자가 "지금 공개"로만 되돌린다).
 * 기록이 없으면 공개 전 (감사를 통과하면 본 Cron이 공개한다)
 */
export const HUB_PUBLIC_PREFIX = "hub_public:";
/** R68: 본 Cron 공개 확인의 마지막 결과 meta `hub_public_check:{id}` = PublishCheck (JSON) — 관리 화면과 한 시간 간격에 쓴다 */
export const HUB_PUBLIC_CHECK_PREFIX = "hub_public_check:";

/** R68: 서버 격리 공간이 공개 목록을 다시 읽는 간격 — 공개·숨김은 늦어도 이만큼 뒤에 모든 격리 공간에 보인다 */
export const PUBLIC_HUBS_TTL_MS = 5 * 60_000;
/** R68: 공개 목록 읽기가 실패하면 알던 목록으로 이만큼 버티고 다시 읽는다 (D1이 아플 때 요청마다 다시 부르지 않게) */
export const PUBLIC_HUBS_RETRY_MS = 30_000;

/** R68: 공개 판단에 쓴 감사 숫자 (worker/audit.ts auditPass와 같은 정의 — 관리 화면 표시용) */
export type AuditSummary = {
  places: number; ok: number; failed: number; missing: number; coverage: number;
  tiles: number; collected: number; saturated: number;
};
export type PublishRecord = { state: "public" | "hidden"; at: number; by: "auto" | "admin"; audit?: AuditSummary };
/**
 * R68 공개 확인 결과. reason: 통과 못 한 첫 조건 — tiles(모으지 않은 격자), saturated(포화 격자), missing(상세 미수집),
 * coverage(상세 커버리지 95 % 미만 — Q2). 통과면 null
 */
export type PublishCheck = {
  at: number; pass: boolean; reason: "tiles" | "saturated" | "missing" | "coverage" | null; audit?: Partial<AuditSummary>;
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const parse = (raw: string | undefined): unknown => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

/** 깨진 값·모르는 모양은 없는 것으로 (null) */
export function parsePublishRecord(raw: string | undefined): PublishRecord | null {
  const v = parse(raw);
  if (!isObj(v) || (v.state !== "public" && v.state !== "hidden") || typeof v.at !== "number") return null;
  if (v.by !== "auto" && v.by !== "admin") return null;
  return v as PublishRecord;
}

export function parsePublishCheck(raw: string | undefined): PublishCheck | null {
  const v = parse(raw);
  if (!isObj(v) || typeof v.at !== "number" || typeof v.pass !== "boolean") return null;
  return v as PublishCheck;
}

/** R68: 공개 후보(HUBS의 ready: false) */
export const candidateHubs = () => HUBS.filter((h) => !h.ready);
/** R68: 후보마다 공개 기록 키 (런타임 목록 읽기) */
export const publishKeys = (): string[] => candidateHubs().map((h) => HUB_PUBLIC_PREFIX + h.id);
/** R68: 후보마다 공개 기록 + 확인 결과 키 (본 Cron·관리 화면) */
export const candidateMetaKeys = (): string[] => candidateHubs().flatMap((h) => [HUB_PUBLIC_PREFIX + h.id, HUB_PUBLIC_CHECK_PREFIX + h.id]);

/** R68: 읽은 meta에서 공개(state public)인 후보 id (HUBS 순서) */
export const publishedFromMeta = (meta: ReadonlyMap<string, string>): string[] =>
  candidateHubs().filter((h) => parsePublishRecord(meta.get(HUB_PUBLIC_PREFIX + h.id))?.state === "public").map((h) => h.id);

// 격리 공간(isolate) 하나의 캐시: 마지막으로 읽은 시각만 (진행 중인 읽기는 요청끼리 나눠 쓰지 않는다 — Fix 1)
let loadedAt = Number.NEGATIVE_INFINITY;

/**
 * R68: 이미 읽은 meta(본 Cron의 한 번 읽기, 관리자 공개·취소)로 런타임 공개 목록을 바꾸고 캐시를 새로 한 것으로 친다 (D1 호출 없음)
 */
export function notePublicHubs(meta: ReadonlyMap<string, string>, now: number): void {
  setPublishedHubIds(publishedFromMeta(meta));
  loadedAt = now;
}

/**
 * R68: 런타임 공개 목록(ready ∪ 공개된 후보)을 이 격리 공간에 알려 둔다 — shared/hubs.ts의 isPublicHubId·publicHubs가 그 값을 쓴다.
 * TTL(5분) 안이면 아무것도 하지 않는다 (목록·이벤트의 뜨거운 경로에 D1 호출이 늘지 않는다). 지나면 후보의 공개 기록을 meta 한 질의로
 * 읽는다(후보마다 기본 키 1행). 진행 중인 읽기를 다른 요청과 나눠 쓰지 않는다 — 다른 요청의 I/O를 기다리면 그 요청이 취소됐을 때
 * 끝나지 않는 약속에 걸려 이 격리 공간의 모든 요청이 멈출 수 있다(Workers는 요청 사이 약속을 풀지 않는다). TTL이 지난 순간 동시에 온
 * 요청들은 저마다 한 행짜리 읽기를 한다. 후보가 없으면(지금 운영) 읽지 않는다.
 * 실패하면 알던 목록을 두고 PUBLIC_HUBS_RETRY_MS 뒤에 다시 읽는다 (던지지 않는다 — 목록·이벤트를 막지 않게)
 */
export async function ensurePublicHubs(db: D1Database, now: number): Promise<void> {
  if (!hasCandidateHubs()) return;
  if (now >= loadedAt && now - loadedAt < PUBLIC_HUBS_TTL_MS) return;
  try {
    const r = await metaKeysStmt(db, publishKeys()).all<{ key: string; value: string }>();
    notePublicHubs(new Map(r.results.map((x) => [x.key, x.value] as const)), now);
  } catch (e) {
    console.error("public hubs read failed", e);
    loadedAt = now - PUBLIC_HUBS_TTL_MS + PUBLIC_HUBS_RETRY_MS;
  }
}

/** 테스트용: 캐시를 비우고 런타임 공개 목록을 ready만으로 되돌린다 */
export function resetPublicHubsCache(): void {
  loadedAt = Number.NEGATIVE_INFINITY;
  setPublishedHubIds([]);
}

const META_SET = "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";

/**
 * R68: 후보의 공개 기록을 쓰고(본 Cron 자동 공개·관리자 공개·취소), 같은 batch로 후보들의 공개 기록을 다시 읽어 이 격리 공간의 목록을
 * 바로 바꾼다 (D1 호출 1번). extra: 같은 batch로 함께 쓸 문장 (본 Cron의 확인 결과). 다른 격리 공간은 늦어도 PUBLIC_HUBS_TTL_MS 뒤에 본다
 */
export async function writePublishRecord(
  db: D1Database, hubId: string, record: PublishRecord, now: number, extra: D1PreparedStatement[] = [],
): Promise<void> {
  // 자동 공개는 기록이 없을 때만 쓴다 — 본 Cron이 meta를 읽은 뒤 관리자가 막 공개를 취소했으면(hidden) 덮지 않는다 (Fix 1 · M1)
  const sql = record.by === "auto" ? "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING" : META_SET;
  const rs = await db.batch<{ key: string; value: string }>([
    db.prepare(sql).bind(HUB_PUBLIC_PREFIX + hubId, JSON.stringify(record)),
    ...extra,
    metaKeysStmt(db, publishKeys()),
  ]);
  notePublicHubs(new Map(rs[rs.length - 1].results.map((x) => [x.key, x.value] as const)), now);
}

/** R68: 공개 확인 결과를 쓰는 문장 (본 Cron) */
export const publishCheckStmt = (db: D1Database, hubId: string, check: PublishCheck): D1PreparedStatement =>
  db.prepare(META_SET).bind(HUB_PUBLIC_CHECK_PREFIX + hubId, JSON.stringify(check));

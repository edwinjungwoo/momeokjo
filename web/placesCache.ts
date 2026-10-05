import { placesCacheEntry, placesCacheEvictions, readPlacesCache, type CachedPlacesView } from "../shared/placesCache";

/**
 * R45: 거점별 마지막 목록 응답을 IndexedDB에 둔다 (원문 0.6~1.0MB × 최대 3곳이라 localStorage 5MB에는 빠듯하다).
 * 화면을 절대 막지 않는다: 모든 함수는 예외를 던지지 않고, 저장소를 못 쓰면(사생활 보호 모드 등) 조용히 없는 셈 친다.
 */
const DB_NAME = "mmj-cache";
const STORE = "places";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  dbPromise ??= new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "hub" }).createIndex("savedAt", "savedAt");
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return dbPromise;
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** 이 거점의 쓸 수 있는 저장본 (없거나 못 읽으면 null) */
export async function readCachedPlaces(hub: string): Promise<CachedPlacesView | null> {
  try {
    const db = await openDb();
    if (!db) return null;
    const raw = await done(db.transaction(STORE, "readonly").objectStore(STORE).get(hub));
    return readPlacesCache(raw, hub, Date.now());
  } catch {
    return null;
  }
}

/** 응답 원문을 저장하고, 오래된 거점은 지운다 (최근 3곳) */
export async function saveCachedPlaces(hub: string, text: string): Promise<void> {
  try {
    const entry = placesCacheEntry(hub, text, Date.now());
    const db = await openDb();
    if (!entry || !db) return;
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    store.put(entry);
    // 원문(거점당 ~1MB)은 읽지 않고 저장 시각 인덱스의 키만 훑는다
    const meta: { hub: string; savedAt: number }[] = [];
    await new Promise<void>((resolve, reject) => {
      const cur = store.index("savedAt").openKeyCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (!c) {
          // 트랜잭션이 살아 있는 이 콜백 안에서 지운다
          for (const h of placesCacheEvictions(meta, hub)) store.delete(h);
          return resolve();
        }
        meta.push({ hub: String(c.primaryKey), savedAt: Number(c.key) });
        c.continue();
      };
      cur.onerror = () => reject(cur.error);
    });
  } catch {
    /* 저장하지 못해도 화면은 그대로 */
  }
}

import { placesCacheEntry, placesCacheEvictions, readPlacesCache, type CachedPlacesView } from "../shared/placesCache";

/**
 * R45: 거점별 마지막 목록 응답을 IndexedDB에 둔다 (원문 0.6~1.0MB × 최대 3곳이라 localStorage 5MB에는 빠듯하다).
 * 화면을 절대 막지 않는다: 모든 함수는 예외를 던지지 않고, 저장소를 못 쓰면(사생활 보호 모드 등) 조용히 없는 셈 친다.
 */
const DB_NAME = "mmj-cache";
const STORE = "places";

let dbPromise: Promise<IDBDatabase | null> | null = null;

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  const p = new Promise<IDBDatabase | null>((resolve) => {
    let failed = false;
    // 한 번 실패한 열기 때문에 새로고침 전까지 저장본이 꺼지지 않게, 다음 호출은 새로 연다
    const fail = () => {
      if (failed) return;
      failed = true;
      if (dbPromise === p) dbPromise = null;
      resolve(null);
    };
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) {
          req.result.createObjectStore(STORE, { keyPath: "hub" }).createIndex("savedAt", "savedAt");
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // 막혀서(onblocked) 이미 실패로 친 뒤에 늦게 열린 연결은 쓰지 않고 닫는다
        if (failed) {
          db.close();
          return;
        }
        // 다른 탭이 버전을 올리거나 WebKit이 연결을 끊으면 다음 호출이 새로 연다
        db.onclose = db.onversionchange = () => {
          db.close();
          if (dbPromise === p) dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = fail;
      req.onblocked = fail;
    } catch {
      // indexedDB가 아예 없거나 막힌 환경(사생활 보호 모드 등)은 이번 페이지 동안 없는 셈 친다
      resolve(null);
    }
  });
  dbPromise = p;
  return p;
}

/** 연 뒤 읽기·저장이 실패하면 그 연결을 닫고, 다음 호출이 새로 열게 한다 */
function resetDb(db: IDBDatabase | null) {
  try {
    db?.close();
  } catch {
    /* 이미 닫힘 */
  }
  dbPromise = null;
}

const done = <T>(req: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/** 이 거점의 쓸 수 있는 저장본 (없거나 못 읽으면 null) */
export async function readCachedPlaces(hub: string): Promise<CachedPlacesView | null> {
  let db: IDBDatabase | null = null;
  try {
    db = await openDb();
    if (!db) return null;
    const raw = await done(db.transaction(STORE, "readonly").objectStore(STORE).get(hub));
    return readPlacesCache(raw, hub, Date.now());
  } catch {
    resetDb(db);
    return null;
  }
}

/** 응답 원문을 저장하고, 오래된 거점은 지운다 (최근 3곳) */
export async function saveCachedPlaces(hub: string, text: string): Promise<void> {
  let db: IDBDatabase | null = null;
  try {
    const entry = placesCacheEntry(hub, text, Date.now());
    db = await openDb();
    if (!db) return;
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    // 너무 커서 못 저장하면 옛 저장본도 지운다 (새 응답보다 오래된 목록이 남지 않게)
    if (entry) store.put(entry);
    else store.delete(hub);
    if (!entry) return;
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
    resetDb(db);
    /* 저장하지 못해도 화면은 그대로 */
  }
}

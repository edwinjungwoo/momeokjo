#!/usr/bin/env bash
# 모먹죠 운영 스모크 테스트 (QA 계획 §3.3, 2026-10-06 API 기준: /api/places?hub=&radius=)
#
# 사용:   B=https://mmj.itmz.me scripts/smoke.sh
# 관리자: 토큰을 화면·기록에 남기지 않게 읽어서 넘긴다 →  read -rs ADMIN_TOKEN && export ADMIN_TOKEN && scripts/smoke.sh
#         (토큰이 있으면 거점마다 감사 Q1·Q2를 더 본다. 토큰 값은 출력하지 않고, curl 인자에도 넣지 않는다)
# R62 준비 중 거점(shared/hubs.ts의 ready: false): 목록은 보지 않고 "공개 API가 400으로 숨기는지"만 본다.
#   감사는 하되 결과를 info로만 찍는다 (FAIL·WARN이 아니라 release.mjs가 롤백·중단 사유로 보지 않는다)
# SMOKE_BASELINE=1 (release의 배포 전 기준 실행에만 붙는다): 로컬 hubs.ts는 새 코드인데 운영은 아직 이전 코드다.
#   ready인 거점이 운영에서 400이면 "공개 예정" WARN, ready가 아닌 거점이 운영에서 200이면 "숨김 예정" WARN으로만 알린다
#   (거점을 공개·숨길 때 --accept-baseline-fails 없이 배포되게). 배포 뒤 스모크는 이 값 없이 돌아 같은 줄이 FAIL이다 → 롤백
#
# 요청 수: 기본 15번 + 거점마다 1번 (+ ADMIN_TOKEN이 있으면 거점 수만큼). 읽기 경로에는 IP 제한이 없지만, 목록 요청이 카카오 수집을
#   새로 부르면 그 수집은 IP당 분당 10회 제한(RATE_LIMITER)과 카카오 쿼터를 쓴다. 관리자 요청(인증 실패 2번 +
#   감사)은 관리자 전용 admin:<IP> 제한(ADMIN_LIMITER, 분당 120회)을 쓴다. 그래서 요청을 아낀다
#   - 목록은 공개 거점마다 한 번만: 봉은사역은 화면과 같은 1000m(R42), 나머지는 500m. 준비 중 거점은 400 확인 한 번(외부 호출 없음)
#   - 정상 이벤트는 보내지 않는다 (운영 통계를 오염시키지 않게). 틀린 본문만 보낸다
# 종료 코드: FAIL이 하나라도 있으면 1. WARN·INFO는 종료 코드에 영향 없음 (pending·stale·TTFB 등 운영 상태)
set -uo pipefail

B=${B:-https://mmj.itmz.me}
B=${B%/}
baseline=false
[ "${SMOKE_BASELINE:-}" = 1 ] && baseline=true
for c in curl jq; do command -v "$c" >/dev/null || { echo "$c이(가) 필요해요" >&2; exit 2; }; done

fails=0 warns=0 reqs=0
notyet=""   # 기준 실행에서 운영이 아직 숨기는 공개 예정 거점 (감사는 info로만)
ok()   { printf "  ok    %s\n" "$1"; }
bad()  { printf "  FAIL  %s\n" "$1"; fails=$((fails + 1)); }
warn() { printf "  WARN  %s\n" "$1"; warns=$((warns + 1)); }
info() { printf "  info  %s\n" "$1"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# req <이름> <curl 인자...> → 본문 $tmp/<이름>.body, 헤더 $tmp/<이름>.h, 결과는 CODE·TTFB·SIZE
# (서브셸에서 부르지 않는다 — 요청 수를 세야 해서)
CODE=000 TTFB=0 SIZE=0
req() {
  local n=$1 out
  shift
  reqs=$((reqs + 1))
  out=$(curl -sS --compressed --max-time 20 -o "$tmp/$n.body" -D "$tmp/$n.h" \
    -w '%{http_code} %{time_starttransfer} %{size_download}' "$@" 2>/dev/null) || out="000 0 0"
  read -r CODE TTFB SIZE <<<"$out"
}
hdr() { grep -i "^$2:" "$tmp/$1.h" 2>/dev/null | tail -1 | cut -d: -f2- | tr -d '\r' | sed 's/^ *//'; }
# 본문을 grep으로 볼 때는 파일을 직접 준다: pipefail에서 `body x | grep -q`는 grep이 먼저 끝나
# cat이 SIGPIPE를 받으면 맞는 본문도 실패로 읽힌다. body는 오류 메시지에 앞부분을 붙일 때만 쓴다
body() { cat "$tmp/$1.body" 2>/dev/null; }
expect_code() { # <이름> <기대 상태> <설명> <curl 인자...>
  local n=$1 want=$2 what=$3
  shift 3
  req "$n" "$@"
  if [ "$CODE" = "$want" ]; then ok "$what → $CODE"; else bad "$what → $CODE (기대 $want)"; fi
}

# 거점 목록은 shared/hubs.ts에서 읽는다 (거점을 늘리면 스모크도 따라간다). 줄마다 "id lat lng ready".
# 저장소 밖에서 돌리면 아래 기본값 (식은 test/shared/release.test.ts가 hubs.ts에 그대로 돌려 본다)
HUBS_TS="$(cd "$(dirname "$0")/.." && pwd)/shared/hubs.ts"
hubs=()
if [ -f "$HUBS_TS" ]; then
  while IFS= read -r line; do hubs+=("$line"); done < <(
    sed -nE 's/.*id: "([a-z0-9-]+)".*lat: ([0-9.]+), lng: ([0-9.]+), ready: (true|false).*/\1 \2 \3 \4/p' "$HUBS_TS"
  )
fi
if [ ${#hubs[@]} -eq 0 ]; then
  hubs=("bongeunsa 37.514255 127.060234 true" "ddp 37.5651 127.00749 true" "pangyo 37.394777 127.11159 true"
    "naebang 37.487659 126.9936 true" "gwacheon 37.426505 126.989868 true")
  # 저장소 안에서 이 목록으로 떨어졌다면 새 거점·ready 변경을 놓친 채 옛 목록으로 확인하는 것이다
  if [ -f "$HUBS_TS" ]; then warn "shared/hubs.ts에서 거점을 읽지 못해 내장 목록으로 확인해요 (sed 식과 hubs.ts 모양 확인)"
  else info "shared/hubs.ts 없음(저장소 밖) — 내장 거점 목록으로 확인"; fi
fi

echo "모먹죠 스모크 → $B"

echo "== 정적 파일"
req index "$B/"
code=$CODE
if [ "$code" = 200 ] && grep -q "<title>모먹죠 - 점심 고?</title>" "$tmp/index.body"; then ok "/ 200, 제목 '모먹죠 - 점심 고?'"; else bad "/ → $code 또는 제목이 다름"; fi
grep -q "점심 ㄱ" "$tmp/index.body" && bad "/ 에 예전 문구 '점심 ㄱ'이 남아 있음"
info "/ cache-control: $(hdr index cache-control)"
asset=$(grep -oE '/assets/[A-Za-z0-9._-]+\.js' "$tmp/index.body" | head -1)

req og "$B/og.png"
code=$CODE
ctype=$(hdr og content-type)
if [ "$code" = 200 ] && [[ "$ctype" == image/png* ]]; then ok "/og.png 200 image/png"; else bad "/og.png → $code ($ctype)"; fi

req robots "$B/robots.txt"
code=$CODE
if [ "$code" = 200 ] && grep -q "^Disallow: /admin" "$tmp/robots.body" && grep -q "^Disallow: /api/" "$tmp/robots.body"; then
  ok "/robots.txt 200, /admin·/api/ 막음"
else bad "/robots.txt → $code 또는 Disallow 줄이 없음"; fi

req pangyo "$B/pangyo"
code=$CODE
if [ "$code" = 200 ] && grep -q '<div id="root">' "$tmp/pangyo.body"; then ok "/pangyo 200 (거점 짧은 링크 → SPA 대체 응답)"; else bad "/pangyo → $code"; fi

req admin "$B/admin"
code=$CODE
if [ "$code" = 200 ]; then ok "/admin 200"; else bad "/admin → $code"; fi
robots_tag=$(hdr admin x-robots-tag)
if [ -n "$robots_tag" ]; then info "/admin X-Robots-Tag: $robots_tag"; else info "/admin X-Robots-Tag 없음 (robots.txt·메타 태그로 막음, 실패 아님)"; fi

if [ -n "$asset" ]; then
  req asset "$B$asset"
  code=$CODE
  cc=$(hdr asset cache-control)
  if [ "$code" = 200 ] && [[ "$cc" == *immutable* ]] && [[ "$cc" == *max-age=31536000* ]]; then ok "$asset 200, $cc"
  else bad "$asset → $code, cache-control '$cc' (immutable 1년 기대, public/_headers 확인)"; fi
else
  bad "/ 에서 /assets/*.js를 찾지 못함"
fi

echo "== 목록 (공개 거점마다 1번, 준비 중 거점은 숨김 확인)"
ELEM_KEYS='["category","detail","distance","group","id","lat","lng","name","photoUrl","url","walkMinutes"]'
DETAIL_KEYS='["bookable","groupFriendly","hours","menus","price","rating","reviewCount","soloFriendly","strengths"]'
TOP_KEYS='["center","detailsFrozenSince","detailsNewestAt","detailsPaused","incompleteTiles","pending","places","radius","refreshDay","refreshedAt","stale"]'
for h in "${hubs[@]}"; do
  read -r id _ _ ready <<<"$h"
  if [ "$ready" != true ]; then
    # R62: 덜 모은 거점은 공개 API가 모르는 거점처럼 400이어야 한다 (200이면 화면 밖에서 덜 모은 목록이 보인다 — 코드 문제)
    if $baseline; then
      req "hidden-$id" "$B/api/places?hub=$id&radius=500"
      if [ "$CODE" = 400 ]; then ok "준비 중 $id 목록 숨김 → 400"
      elif [ "$CODE" = 200 ]; then warn "숨김 예정 $id: 운영은 아직 공개 중 (배포 뒤에는 400이어야 함)"
      else bad "준비 중 $id 목록 숨김 → $CODE (기대 400)"; fi
    else
      expect_code "hidden-$id" 400 "준비 중 $id 목록 숨김" "$B/api/places?hub=$id&radius=500"
    fi
    continue
  fi
  r=500
  [ "$id" = bongeunsa ] && r=1000
  req "places-$id" "$B/api/places?hub=$id&radius=$r"
  code=$CODE ttfb=$TTFB size=$SIZE
  if $baseline && [ "$code" = 400 ]; then
    # 새로 공개할 거점: 이전 코드의 운영은 아직 모르는 거점이라 400이다
    warn "공개 예정 $id: 운영은 아직 숨김 (400)"
    notyet="$notyet $id "
    continue
  fi
  if [ "$code" != 200 ] || ! jq -e . "$tmp/places-$id.body" >/dev/null 2>&1; then
    bad "$id ${r}m → $code"
    continue
  fi
  f="$tmp/places-$id.body"
  n=$(jq '.places | length' "$f")
  if [ "$n" -gt 0 ]; then ok "$id ${r}m 200, ${n}곳"; else bad "$id ${r}m 200인데 0곳"; fi
  # R42: 서버는 반경 값과 상관없이 거점의 1000m 목록 하나만 계산·캐시한다(화면이 반경으로 거름)
  jq -e '.radius == 1000 and ([.places[].distance] | all(. <= 1000))' "$f" >/dev/null \
    && ok "$id 1000m 목록(반경 ${r} 요청)" || bad "$id 응답 반경이 1000이 아니거나 1000m 밖 가게가 있음"
  jq -e --argjson top "$TOP_KEYS" --argjson el "$ELEM_KEYS" --argjson de "$DETAIL_KEYS" \
    '((keys - $top) | length == 0) and (([.places[] | keys[]] | unique) - $el | length == 0)
     and (([.places[] | .detail // {} | keys[]] | unique) - $de | length == 0)' "$f" >/dev/null \
    && ok "$id 응답·원소 키가 허용 목록 안" || bad "$id 응답에 예상 밖 키 (주소·전화·태그 등)"
  read -r pending incomplete stale frozen < <(jq -r '[.pending, .incompleteTiles, .stale, (.detailsFrozenSince // "null")] | @tsv' "$f")
  [ "$pending" = 0 ] && ok "$id pending 0" || warn "$id pending $pending (상세 보충 중 — Cron/warm 확인)"
  [ "$incomplete" = 0 ] || warn "$id incompleteTiles $incomplete (격자 수집 중)"
  [ "$stale" = false ] || warn "$id stale (요청 제한 또는 카카오 실패)"
  [ "$frozen" = null ] || warn "$id 강등 모드(R44) detailsFrozenSince=$frozen"
  if awk "BEGIN{exit !($ttfb < 2.0)}"; then ok "$id TTFB ${ttfb}s"; else warn "$id TTFB ${ttfb}s (2초 넘음)"; fi
  info "$id 전송 ${size}B, content-encoding: $(hdr "places-$id" content-encoding), cache-control: $(hdr "places-$id" cache-control)"
done

echo "== 입력 검증 (외부 호출이 일어나지 않는 요청만)"
expect_code r99 400 "반경 99" "$B/api/places?hub=bongeunsa&radius=99"
expect_code r1001 400 "반경 1001" "$B/api/places?hub=bongeunsa&radius=1001"
expect_code r525 400 "반경 525 (50m 단위 아님)" "$B/api/places?hub=bongeunsa&radius=525"
expect_code hubx 400 "모르는 거점" "$B/api/places?hub=atlantis&radius=500"
expect_code id16 404 "16자리 id" "$B/api/places/1234567890123456"

echo "== 이벤트 (정상 이벤트는 보내지 않음)"
req evbad -X POST -H 'content-type: application/json' \
  --data-binary '{"anon":"smoke","session":"smoke","events":[]}' "$B/api/events"
code=$CODE
if [ "$code" = 400 ] && jq -e '.error == "invalid_body"' "$tmp/evbad.body" >/dev/null 2>&1; then ok "틀린 본문 → 400 invalid_body"
else bad "틀린 본문 → $code $(body evbad | head -c 80)"; fi
head -c 9000 /dev/zero | tr '\0' a | sed 's/^/{"pad":"/; s/$/"}/' >"$tmp/big.json"
req evbig -X POST -H 'content-type: application/json' --data-binary @"$tmp/big.json" "$B/api/events"
code=$CODE
if [ "$code" = 400 ] && jq -e '.error == "too_large"' "$tmp/evbig.body" >/dev/null 2>&1; then ok "8KB 넘는 본문 → 400 too_large"
else bad "8KB 넘는 본문 → $code $(body evbig | head -c 80)"; fi

echo "== 관리자"
expect_code adm-none 401 "통계 토큰 없이" "$B/api/admin/stats"
expect_code adm-wrong 401 "통계 틀린 토큰" -H "Authorization: Bearer smoke-wrong-token" "$B/api/admin/stats"
if [ -n "${ADMIN_TOKEN:-}" ]; then
  for h in "${hubs[@]}"; do
    read -r id lat lng ready <<<"$h"
    # 토큰은 curl 설정(-K, 프로세스 치환)으로만 넘긴다 — 명령줄 인자·출력에 남지 않게.
    # bash -x(set -x)로 돌리지 않는다: 아래 printf 줄이 토큰을 그대로 찍는다
    req "audit-$id" -K <(printf 'header = "Authorization: Bearer %s"\n' "$ADMIN_TOKEN") \
      "$B/api/admin/audit?lat=$lat&lng=$lng&radius=1000"
    code=$CODE
    f="$tmp/audit-$id.body"
    if [ "$ready" != true ]; then
      info "감사 $id(준비 중) → $code $(jq -c '{pass, places, tiles, detail: (.detail // null)}' "$f" 2>/dev/null) — 공개 전 확인용, FAIL로 세지 않음"
      continue
    fi
    if [[ "$notyet" == *" $id "* ]]; then
      info "감사 $id(공개 예정, 운영은 아직 숨김) → $code — 기준 실행이라 FAIL로 세지 않음"
      continue
    fi
    if [ "$code" = 200 ] && jq -e '.pass.q1 and .pass.q2' "$f" >/dev/null 2>&1; then
      ok "감사 $id 1000m Q1·Q2 통과 ($(jq -r '"장소 \(.places), 상세 \(.detail.coverage * 100 | floor)%"' "$f"))"
    else
      bad "감사 $id → $code $(jq -c '{pass, tiles, detail: (.detail // null)}' "$f" 2>/dev/null)"
    fi
  done
else
  info "ADMIN_TOKEN이 없어 감사(Q1·Q2)는 건너뜀"
fi

echo
echo "요청 ${reqs}번 · FAIL ${fails} · WARN ${warns}"
[ "$fails" -eq 0 ]

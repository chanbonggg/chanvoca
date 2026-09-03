# ChanVoca 전체 구현 계획

## 1. 목표와 완료 기준

개인 사용자가 매일 단어 파일 하나를 업로드하고, 최신 또는 직접 선택한 Day의 누적 복습 계획을 모바일 PWA에서 끝까지 수행하는 것이 핵심 흐름이다.

최초 배포 완료 기준은 다음과 같다.

1. 개인 서버의 앱을 열어 바로 사용한다. 초기 버전에는 앱 로그인이 없다.
2. `.xlsx`, `.xls`, `.csv` 파일을 업로드하면 새 Day가 생기며 모든 행이 독립 카드로 저장된다.
3. 업로드 응답은 Groq 예문 생성을 기다리지 않고 빠르게 돌아온다.
4. 최신 Day 또는 메뉴에서 선택한 Day 기준으로 누적 Day 집합을 정확히 계산한다.
5. 10초 타이머, 뜻 공개, 알았어요/몰랐어요, 시간 초과, 반복 라운드, 전체 재시작이 모바일에서 안정적으로 동작한다.
6. 세션별 정답/오답/시간 초과/라운드 수가 DB에 남고 새로고침 후 진행을 복구한다.
7. 설치된 PWA에서 사용자가 정한 시각에 웹 푸시를 받고, 누르면 최신 누적 학습 화면이 열린다.
8. Groq·푸시·네트워크 실패가 카드 학습 자체를 막지 않는다.
9. `GROQ_API_KEY`와 모든 개인 키는 서버에만 존재한다.
10. 앱은 개인 네트워크 또는 별도 접근 제한 뒤에서만 실행한다.

### 저장소와 런타임 구조

```text
chanvoca/
├─ frontend/                 Next.js UI/PWA
│  ├─ src/app/
│  ├─ src/components/
│  └─ public/
├─ backend/                  Fastify 모듈형 모놀리스
│  └─ src/
│     ├─ modules/
│     │  ├─ system/          health/readiness
│     │  ├─ days/            업로드, Day, 카드
│     │  ├─ study/           계획, 세션, 라운드, 결과
│     │  ├─ examples/        Groq 예문, job queue
│     │  └─ notifications/   구독, 설정, scheduler
│     ├─ shared/             실제 공용 DB/config/error만
│     ├─ app.ts              Fastify 조립
│     ├─ server.ts           HTTP entrypoint
│     └─ worker.ts           예문·푸시 작업 worker entrypoint
├─ docs/
└─ compose.yaml
```

- 프론트엔드는 DB와 Groq를 직접 호출하지 않고 `/api/*`만 호출한다.
- 개발 중 Next.js rewrite가 `/api/*`를 `localhost:4000`으로 전달한다.
- 운영에서는 reverse proxy가 정적/페이지 요청을 frontend로, `/api/*`를 backend로 보낸다.
- backend는 하나의 배포 단위와 하나의 DB를 유지한다. 모듈별 프로세스나 DB를 만들지 않는다.
- 각 도메인 모듈이 route, 규칙, SQL을 함께 소유한다. 파일이 커지거나 재사용이 생길 때만 분리한다.
- `days`는 카드 원본을 소유하고, `study`는 card ID를 참조하며 내용을 복제하지 않는다.
- `examples`는 card ID를 받아 예문 필드와 job을 관리하고, `notifications`는 학습 내부 로직을 직접 가져오지 않고 학습 URL만 생성한다.

## 2. 사용자 흐름

### 첫 실행

1. 앱을 열었을 때 Day가 없으면 빈 상태와 `메뉴에서 업로드` 행동을 보여준다.
2. 햄버거 메뉴에서 파일을 선택한다.
3. 서버가 파일 구조를 검증하고 Day 1과 카드들을 저장한다.
4. 화면은 즉시 Day 1을 선택한 상태가 되고, 예문은 카드별로 `생성 중`일 수 있다.
5. 사용자는 예문 완료를 기다리지 않고 학습을 시작할 수 있다.

### 매일 업로드

1. 업로드 버튼에서 파일 하나를 선택한다.
2. 클라이언트는 파일 이름, 크기, 확장자를 선검사하되 서버가 동일 검사를 다시 한다.
3. 서버는 첫 행을 header로 버리고 첫 두 열만 읽는다.
4. 서버가 다음 Day 번호를 배정하고 모든 유효 행을 삽입한다.
5. 카드마다 예문 생성 작업을 enqueue하고 새 Day 메타데이터를 반환한다.
6. 메뉴 Day 목록 맨 위에 새 Day가 보이고 기본 계획 기준이 새 Day로 바뀐다.

### 학습

1. 최신 Day 또는 직접 선택한 Day로 새 세션을 생성한다.
2. 서버는 오프셋 `[0, 1, 3, 6, 13, 29]`를 적용해 존재하는 Day만 고른다.
3. 포함된 모든 카드를 카드 ID 기준으로 섞는다.
4. 카드가 완전히 표시된 시점에 10초 deadline을 만든다.
5. 앞면을 누르면 timer를 멈추고 뜻·예문·해석을 보여준다.
6. `알았어요`는 카드를 통과 처리한다. `몰랐어요`는 다음 라운드 대상으로 남긴다.
7. deadline까지 뜻을 보지 못하면 `timeout`을 저장하고 뒷면을 약 1.2초 보여준 뒤 다음 카드로 간다.
8. 라운드 끝에는 `unknown`과 `timeout` 카드만 다시 낸다. Day 묶음은 최신 Day부터 과거 Day 순서를 유지하고, 각 Day 안에서만 섞는다.
9. 남은 카드가 0개면 완료 화면과 통계를 보여준다.
10. `전체 다시 반복하기`는 이전 세션에 연결된 새 세션을 생성한다.

### 알림

1. 메뉴에서 알림 설정을 열고 브라우저 지원 여부와 PWA 설치 상태를 확인한다.
2. 사용자가 버튼을 눌렀을 때만 알림 권한을 요청한다.
3. 허용되면 service worker의 PushSubscription을 서버에 저장한다.
4. 사용자가 현지 시각을 정하고 활성화한다.
5. scheduler는 매분 발송 대상을 찾고 날짜별 한 번만 작업을 enqueue한다.
6. 알림을 누르면 `/`의 최신 Day 계획으로 이동한다.

## 3. 누적 복습 계산

기준 Day 번호를 `N`이라 할 때 후보는 다음과 같다.

```ts
const reviewOffsets = [0, 1, 3, 6, 13, 29] as const;
const dayNumbers = reviewOffsets
  .map((offset) => N - offset)
  .filter((dayNumber) => dayNumber > 0);
```

서버는 후보 번호를 `(user_id, day_number)`로 조회하고 없는 Day를 무시한다. 번호 순서는 최신에서 과거 순으로 유지하되, 최종 카드는 Day 경계 없이 전체 셔플한다.

검증 예:

| 기준 | 후보 | 실제 Day가 모두 존재할 때 결과 |
| --- | --- | --- |
| Day 1 | `1, 0, -2, -5, -12, -28` | `1` |
| Day 2 | `2, 1, -1, -4, -11, -27` | `2, 1` |
| Day 7 | `7, 6, 4, 1, -6, -22` | `7, 6, 4, 1` |
| Day 30 | `30, 29, 27, 24, 17, 1` | `30, 29, 27, 24, 17, 1` |

Day 24가 실제로 없다면 Day 30 결과는 `30, 29, 27, 17, 1`이다. 단어 중복 제거는 어느 단계에서도 하지 않는다.

## 4. 카드 상태 기계

클라이언트의 한 카드 상태는 최소한으로 아래 네 가지다.

```text
front(counting)
  ├─ tap before deadline ──> back(awaiting_answer)
  │                            ├─ known ──> saving ──> next
  │                            └─ unknown ─> saving ──> next
  └─ deadline ─────────────> timeout_reveal ─> saving ─> next
```

구현 규칙:

- `setInterval` 횟수를 진실의 원천으로 쓰지 않는다. `performance.now() + 10_000` deadline과 현재 시각의 차이로 남은 시간을 계산한다.
- 카드 `id`가 바뀔 때 기존 timeout/interval을 정리하고 새 timer를 시작한다.
- 뜻을 공개하는 순간 deadline timer를 취소한다.
- 공개 후 답변 버튼을 중복 탭하지 못하게 즉시 잠근다.
- 네트워크 저장 중 다음 카드를 보여줄 수는 있지만, 실패한 결과는 메모리 retry queue에 남기고 UI에 동기화 상태를 표시한다. 세션 완료 확정은 서버가 모든 attempt를 받은 뒤에만 한다.
- `timeout`은 `unknown`과 같은 다음 라운드 대상이지만 통계에서는 별도 집계한다.
- 예문이 `pending/processing`이면 `예문 생성 중`, `failed`면 `예문 없음`을 표시한다. 뜻과 답변 버튼은 항상 정상 동작한다.
- 접근성을 위해 카드 탭 외에 키보드 Enter/Space로 뜻을 열 수 있고, 버튼에는 명확한 accessible name을 둔다.
- `prefers-reduced-motion`에서는 카드 전환 애니메이션을 제거한다.

## 5. 파일 업로드 처리

### 입력 계약

- 파일 하나만 받는다.
- 확장자, MIME type, 파일 signature를 함께 확인한다. 확장자만 신뢰하지 않는다.
- 첫 worksheet만 사용한다. 여러 sheet 병합은 하지 않는다.
- 첫 행은 내용과 관계없이 header로 간주한다.
- 두 번째 행부터 첫 번째 열은 영어 단어, 두 번째 열은 뜻이다. 그 뒤 열은 무시한다.
- cell 값은 문자열로 정규화하고 앞뒤 공백만 제거한다. 대소문자·구두점·내부 공백은 사용자의 데이터이므로 바꾸지 않는다.
- 완전히 빈 행은 건너뛴다.
- 한쪽 열만 빈 행은 업로드 실패로 보고 최대 20개 오류 행 번호를 반환한다.
- 수식은 계산 결과 캐시값만 읽고 수식을 실행하지 않는다.
- 매크로, 외부 링크, 스타일, 이미지는 읽거나 저장하지 않는다.

### 제한 기본안

- 파일 크기: 10 MiB
- 데이터 행: 파일당 5,000개
- cell별 최대 길이: 단어 200자, 뜻 1,000자
- CSV 인코딩: UTF-8만 허용한다. BOM은 허용하고 다른 인코딩 자동 추측은 하지 않는다.

이 값은 실제 사용자 파일을 확인한 후 조정한다.

### 서버 처리 순서/

1. content type과 same-origin 요청을 검사한다.
2. body를 제한 크기까지만 읽는다.
3. 파일 형식을 감지하고 workbook/CSV를 파싱한다.
4. 모든 행을 메모리에서 검증한다. 제한을 넘으면 DB transaction 전에 실패한다.
5. transaction을 시작하고 사용자별 Day 번호 lock을 잡는다.
6. 다음 Day와 모든 카드를 batch insert한다.
7. 카드 ID를 dedupe key로 예문 작업을 batch insert한다.
8. commit 후 임시 buffer를 해제하고 `201`을 반환한다.

DB 오류 때는 Day만 생기거나 카드 일부만 남지 않아야 한다. 동일 파일을 사용자가 다시 업로드하면 의도대로 새 Day와 새 카드가 생긴다. HTTP 자동 재시도에 의한 우발적 중복 Day 방지가 필요하면 추후 요청 단위 idempotency key를 추가하되, 파일 hash로 자동 병합하지 않는다.

## 6. LLM 예문 작업

### 프롬프트 계약

worker는 DB에서 카드 ID를 읽고 최신 `term`, `meaning`을 가져온 뒤 Groq API를 호출한다. Node.js 내장 `fetch`를 사용해 `https://api.groq.com/openai/v1/chat/completions`에 요청하고, SDK 의존성은 추가하지 않는다. 모델은 `GROQ_MODEL=openai/gpt-oss-120b`로 설정한다. 시스템 지침은 다음을 요구한다.

- 입력한 한국어 뜻을 가장 우선해 그 의미로 단어를 사용한다.
- 짧고 자연스러운 영어 문장 하나를 만든다.
- 초급~중급 학습자가 이해할 길이와 어휘를 선호한다.
- 한국어 해석 하나를 만든다.
- 설명, markdown, 다른 후보 없이 구조화된 JSON만 반환한다.

예상 구조:

```json
{ "exampleEn": "She remained calm under pressure.", "exampleKo": "그녀는 압박 속에서도 침착함을 유지했다." }
```

### 검증과 저장

- JSON parsing, 키 존재, 문자열 타입, 비어 있지 않음, 길이 제한을 검사한다.
- 영어 예문에 입력 단어가 형태 변화로 없어도 의미가 맞으면 허용한다. 엄격한 문자열 포함 검사는 하지 않는다.
- 성공 시 예문 두 필드와 `ready` 상태를 한 transaction에 저장하고 job을 완료한다.
- 이미 `ready`인 카드의 중복 작업은 LLM을 호출하지 않고 완료 처리한다.
- 실패 시 카드 학습을 막지 않고 정규화된 오류 코드와 재시도 시각만 기록한다.
- 원본 LLM 응답 전문과 API 키는 로그에 남기지 않는다.
- timeout, 429, 일시적 5xx는 재시도하고 Groq 인증 오류와 잘못된 모델 이름은 빠르게 실패시켜 운영 로그에서 드러낸다.

### 처리량 제어

- worker concurrency 기본값은 3으로 시작한다.
- Groq rate limit을 만나면 전역 backoff를 적용한다.
- 한 작업은 카드 하나를 책임진다. Groq batch 처리의 비용 이점이 실제로 확인될 때만 batch 호출을 추가한다.
- UI는 예문 준비율을 polling하지만 학습 시작을 차단하지 않는다.

## 7. 개인 서버 접근과 보안

### 초기 접근 모델

- 앱 자체 로그인과 session은 만들지 않는다.
- 서버 시작 또는 별도 bootstrap 명령에서 `owner` 사용자 한 명을 만든다.
- 모든 API는 서버가 조회한 owner ID만 사용하고 요청 body의 user ID를 받지 않는다.
- 개인 LAN, VPN/Tailscale 또는 리버스 프록시 인증 뒤에서만 서비스한다.
- 공인 인터넷에 접근 제한 없이 노출해야 하는 상황이 생기면 그 배포 전에 앱 로그인을 구현한다.

### 신뢰 경계

- `GROQ_API_KEY`, DB URL, VAPID private key는 server-only 모듈에서만 읽는다.
- `NEXT_PUBLIC_VAPID_PUBLIC_KEY`만 공개 환경변수다. VAPID 공개 키는 공개되어도 되는 값이다.
- 업로드 파일 이름은 경로로 사용하지 않고 표시용 문자열로만 저장한다.
- workbook parser와 LLM SDK는 서버에서만 import한다.
- 모든 SQL은 parameterized query를 사용한다.
- 상태 변경 route는 owner 범위, Origin, content type을 검사한다.
- 테스트 푸시는 rate limit한다.
- 로그에는 비밀번호, cookie, push auth key, LLM 키, 파일 내용 전체를 남기지 않는다.
- 운영 응답에 stack trace와 공급자 원문 오류를 노출하지 않는다.

## 8. PWA와 모바일 UI

### 앱 셸

- 화면 너비 520px 이하에서는 전체 viewport를 사용한다.
- 큰 화면에서는 중앙의 모바일 프레임처럼 보이되 모든 기능을 유지한다.
- `100dvh`와 safe-area inset으로 iOS 주소창과 홈 인디케이터를 고려한다.
- 상단은 햄버거, Day, 진행률/타이머만 유지한다.
- 카드는 남은 세로 공간 대부분을 차지한다.
- 답변 버튼은 하단 엄지 영역에 최소 56px 높이로 고정한다.
- 다크 배경과 충분한 대비, 44px 이상의 터치 대상, reduced motion, focus-visible을 검증한다.

### 메뉴

- 최신순 Day 목록: Day 번호, 카드 수, 업로드 날짜, 예문 상태.
- 현재 Day를 명확히 표시한다.
- 업로드 control과 처리/오류 상태를 메뉴 안에서 제공한다.
- 알림 지원 여부, 설치 필요 안내, 권한 상태, 시각 설정, 테스트 버튼을 메뉴 안에 둔다.
- drawer를 열면 배경 focus 이동을 막고 닫을 때 원래 버튼으로 focus를 복구한다.

### 설치 자산

- 현재 골격의 SVG는 개발용이다.
- 출시 전 독립 제작한 192x192, 512x512 PNG maskable icon과 180x180 Apple touch icon을 만든다.
- manifest의 이름, 색상, `display: standalone`, start URL을 실제 도메인에서 검사한다.
- 설치 유도는 브라우저별 차이를 감지해 안내하되 강제 popup으로 방해하지 않는다.

### 서비스 워커

- 초기 역할은 push 수신과 notification click 처리뿐이다.
- 알림 URL은 same-origin만 허용하고 아니면 `/`로 fallback한다.
- service worker update는 새 버전 배포 후 닫힌 앱에서도 자연스럽게 교체되는지 확인한다.
- offline cache는 요구가 확정되기 전에는 넣지 않는다. 잘못된 cache가 오래된 API/세션을 제공하는 위험을 피한다.

## 9. 알림 스케줄러

### 권한과 구독

- `Notification.requestPermission()`은 사용자가 알림 켜기 버튼을 누른 handler 안에서만 호출한다.
- 지원하지 않는 브라우저에는 대체 안내를 보이고 오류처럼 취급하지 않는다.
- iOS에서는 홈 화면 설치가 필요한 조건을 탐지해 단계별 안내를 보여준다.
- 권한이 `denied`면 브라우저 설정에서 변경하는 방법을 안내하고 반복 요청하지 않는다.
- subscription의 endpoint와 key를 서버에 저장한다. 여러 기기 구독을 허용한다.

### scheduler algorithm

1. worker가 매분 실행된다.
2. 활성 설정 중 현재 UTC 시각이 각 timezone의 `local_time` 분과 일치하고 오늘 아직 enqueue하지 않은 사용자를 찾는다.
3. 사용자 행/설정을 lock하고 `last_enqueued_local_date`를 확인한다.
4. 활성 push subscription마다 `send_push` job을 넣고 날짜를 기록한다.
5. push worker가 payload에 제목, 짧은 본문, same-origin 최신 학습 URL만 넣어 전송한다.
6. 404/410이면 해당 subscription을 비활성화한다. 429/5xx는 제한적으로 재시도한다.

현재 worker는 설정한 현지 분에만 enqueue한다. 서버 재시작 뒤 놓친 알림을 같은 날 보낼지와 허용 지연 시간은 사용자 정책을 확인한 뒤 추가한다.

DST가 있는 timezone에서도 현지 날짜당 최대 한 번이라는 규칙을 유지한다.

## 10. 관찰성과 실패 처리

최소 구조화 로그 필드:

- `requestId`, route, status, durationMs
- 업로드: user ID, day ID, format, row count, duration; 단어/뜻 원문 제외
- job: job ID, kind, attempt, duration, result, normalized error code
- study: session ID, attempt result; 카드 원문 제외
- push: subscription ID hash, HTTP result; endpoint/auth 원문 제외

health check를 둘로 나눈다.

- `/api/health`: 프로세스가 응답하는지 확인하며 DB를 건드리지 않는다.
- `/api/ready`(DB 구현 단계): `SELECT 1`과 필수 migration 버전을 확인한다.

초기에는 외부 모니터링 SDK를 추가하지 않고 플랫폼 로그와 health check를 사용한다. 실제 장애 추적이 부족할 때 오류 수집 도구를 추가한다.

## 11. 단계별 구현과 검증

### Phase 0 — 분리형 프로젝트 골격 (완료)

산출물:

- npm workspace와 `frontend/`, `backend/` 분리
- Next.js/TypeScript PWA 실행 구성
- Fastify/TypeScript API 실행 구성과 system health test
- 모바일 다크 모드 빈 학습 화면과 drawer 골격
- manifest, service worker 등록, 개발용 아이콘
- backend health route, frontend API rewrite, PostgreSQL Compose, 앱별 환경변수 예시
- 설계/계획/미결정 문서

검증:

- `npm install`, lint, typecheck, production build
- 360x800, 390x844, 430x932, desktop 화면에서 overflow 확인
- manifest route와 service worker 200 응답 확인

### Phase 1 — DB schema와 migration (핵심 흐름 검증 완료)

작업:

1. PostgreSQL driver 하나를 선택하고 추가한다.
2. `backend/db/migrations/0001_initial.sql`을 작성한다.
3. migration runner와 schema version table을 최소 구현한다.
4. users, days, cards, jobs, sessions, attempts, push 테이블과 제약을 만든다.
5. seed/bootstrap으로 owner 사용자를 만든다.

검증:

- 빈 DB에 migration 성공
- migration을 다시 실행해 중복 적용하지 않음
- 사용자별 Day 번호 unique와 카드 중복 허용 확인
- cascade/restrict 정책 확인
- DB 미연결 시 ready check가 실패하고 health check는 살아 있음

### Phase 2 — 단일 owner와 API 기반 (기본 구현 완료, 공개 전 접근 제한 필요)

작업:

1. owner bootstrap과 공통 owner ID 조회 helper를 만든다.
2. 클라이언트 user ID를 받지 않는 단일 owner API 경계를 만든다.
3. Origin/content type 검사를 상태 변경 route에 적용한다.
4. 공통 API 오류 형태와 request ID를 적용한다.

검증:

- owner가 없을 때 한 번만 안전하게 생성됨
- owner가 이미 있을 때 중복 생성되지 않음
- 요청 body에 user ID를 넣어도 무시하거나 거부함
- 잘못된 Origin과 content type 거부
- 공통 오류 응답에 내부 stack과 비밀값이 없음

### Phase 3 — 업로드와 Day 목록 (핵심 DB 통합 검증 완료)

작업:

1. Excel/CSV parser 의존성을 하나 추가한다.
2. 파일 검증과 행 정규화를 순수 함수로 작성한다.
3. transaction 기반 Day/카드/job batch insert를 구현한다.
4. 메뉴 Day 목록, 업로드 진행/성공/행 오류 UI를 연결한다.
5. 새 업로드 후 최신 Day를 기본 선택한다.

검증 fixture:

- 정상 xlsx, 구형 xls, UTF-8 CSV/BOM CSV
- header만 있는 파일, 빈 파일, 첫 sheet가 빈 workbook
- 한 열 누락, 중간 빈 행, 한쪽 cell만 빈 행
- 같은 파일 내 중복, 이전 Day와 중복
- 10 MiB/5,000행 경계, 매우 긴 cell
- 잘못된 확장자, 확장자 위장, 깨진 workbook
- 동시에 두 번 업로드해 Day 번호가 충돌하지 않음
- DB 실패 때 부분 Day가 남지 않음

### Phase 4 — PostgreSQL queue와 LLM worker (실 Groq 저장 흐름 검증 완료)

작업:

1. job claim/complete/retry/recover 쿼리를 작성한다.
2. worker entrypoint와 정상 종료 처리를 만든다.
3. 서버 전용 LLM 호출, 구조화 응답 검증, timeout을 구현한다.
4. 예문 상태 표시와 제한된 polling을 연결한다.

검증:

- 여러 worker가 같은 job을 두 번 처리하지 않음
- worker 강제 종료 후 stale job 복구
- 이미 ready인 카드 재생성 없음
- timeout, 429, 500, 잘못된 JSON, 빈 문장, 인증 오류
- `GROQ_API_KEY`가 client bundle, HTML, 로그, 에러 응답에 없음
- LLM 전체 장애 중에도 학습 API와 UI 정상

### Phase 5 — 학습 엔진 (DB 통합·모바일 핵심 흐름 검증 완료)

작업:

1. 누적 Day 계산을 순수 함수와 DB query로 만든다.
2. session과 고정 카드 집합을 생성한다.
3. 카드 front/back, deadline timer, 자동 reveal을 구현한다.
4. attempt idempotent 저장과 round 전환을 구현한다.
5. 새로고침 복구, 완료 화면, 전체 반복을 연결한다.

필수 자동 테스트:

- Day 1, 2, 7, 30 및 중간 Day 누락
- 모든 카드 known이면 1라운드 완료
- unknown만 다음 라운드에 포함
- timeout만 다음 라운드에 포함되고 별도 집계
- 같은 단어의 서로 다른 카드 ID가 모두 출제
- 답변 중복 탭과 attempt 재전송
- timer 9.9초 reveal, 10초 timeout 경계
- background 후 복귀 시 deadline 기반 timeout
- 마지막 카드 결과 저장 실패 시 완료로 오판하지 않음
- 전체 반복이 모든 계획 카드를 새로 포함

### Phase 6 — PWA 마감

작업:

1. 출시용 독립 아이콘 세트를 만든다.
2. install 안내와 standalone 감지를 구현한다.
3. drawer focus trap/복구, reduced motion, focus visible을 마감한다.
4. 모바일 브라우저별 safe-area와 viewport 문제를 수정한다.

검증:

- Chrome Android 설치/실행/업데이트
- Safari iOS 홈 화면 추가와 standalone 실행
- Samsung Internet/desktop Chromium 기본 동작
- Lighthouse PWA/접근성 결과를 참고하되 실제 기기 동작을 우선
- 320px 너비, 큰 글꼴, 가로 모드에서 중요 버튼 접근 가능

### Phase 7 — Web Push와 scheduler (코드 완료, 실제 브라우저/푸시 검증 대기)

작업:

1. VAPID 키 생성 안내와 환경 검증을 추가한다.
2. 권한/지원/PWA 설치 상태 UI를 구현한다.
3. subscription CRUD와 test push를 구현한다.
4. timezone scheduler와 push job handler를 구현한다.
5. notification click deep link를 연결한다.

검증:

- granted, denied, default, unsupported 상태
- iOS 미설치/설치 상태 안내
- 같은 날 중복 scheduler 실행에도 1회만 enqueue
- 서버가 정시 꺼졌다 켜져도 허용 지연 내 1회 발송
- timezone과 DST 경계
- 만료 endpoint 404/410 비활성화
- notification click이 기존 창 focus 또는 새 창 open
- 외부 URL payload가 same-origin fallback 처리

### Phase 8 — 개인 서버 운영 준비와 배포 (Compose 구성 완료, 서버 정보·실행 검증 대기)

작업:

1. production Docker image와 개인 서버용 Compose 구성을 만든다.
2. web, worker/scheduler, PostgreSQL, reverse proxy를 서비스로 분리한다.
3. HTTPS 주소, 영속 DB volume, 서버 전용 환경변수를 연결한다.
4. VPN/Tailscale 또는 reverse proxy 인증 중 선택한 접근 제한을 적용한다.
5. DB backup/restore를 실제로 한 번 연습한다.
6. 로그 보존과 health check alert를 설정한다.

배포 순서:

1. DB backup 확인
2. migration 실행
3. web 배포와 ready check
4. worker 한 개 시작
5. test upload → 예문 생성 → 학습 완료 → test push smoke test
6. 이전 버전 image와 rollback 절차 기록

## 12. 테스트 전략

### 단위 테스트

작고 오류 가능성이 높은 순수 로직만 집중한다.

- review Day 번호 계산
- 파일 행 정규화와 validation
- LLM 응답 validation
- timer reducer/state machine
- timezone 발송 대상 판단

### 통합 테스트

실제 PostgreSQL을 사용한다.

- migration과 제약
- upload transaction
- queue claim/retry/recover
- session/attempt/round transaction
- scheduler dedupe

### E2E

핵심 경로만 유지한다.

1. CSV 업로드 → Day 생성
2. 카드 reveal → unknown → 다음 라운드 → 완료
3. timeout → reveal → 다음 카드
4. 완료 → 전체 반복
5. push subscription은 브라우저 자동화 한계가 있어 API 통합 테스트와 실제 기기 체크리스트를 병행한다.

### 수동 모바일 체크리스트

- 엄지 한 손 조작
- 카드가 화면 대부분을 차지하는지
- 상/하단 safe area와 키보드 등장
- 느린 3G에서 결과 저장 피드백
- 화면 잠금/앱 전환/복귀 때 timer
- PWA 업데이트 후 진행 중 세션 복구
- 알림 권한 거부 후 반복적으로 방해하지 않는지

## 13. 성능 목표 초안

- 앱 shell: 보통 모바일 네트워크에서 빠르게 첫 화면 표시, 불필요한 클라이언트 JavaScript 최소화
- Day 목록: 개인용 수백 Day 범위에서 300ms 이내 API 응답 목표
- 세션 생성: 카드 1,000개 기준 1초 이내 목표
- attempt 저장: p95 300ms 이내 목표
- upload: 5,000행 파싱과 DB 저장은 플랫폼 request timeout 안에 완료. 넘으면 파싱 자체도 업로드 job으로 옮길지 측정 후 결정
- LLM: 비동기이므로 UI latency 목표에서 분리, queue 대기/실패율을 관찰

수치는 개발 장비와 배포 환경에서 측정한 뒤 수정한다.

## 14. 완료 정의

각 Phase는 다음을 모두 만족해야 끝난다.

- 해당 기능의 정상 경로가 실제 브라우저에서 동작한다.
- 명시한 실패 경로가 사용자 데이터를 부분 저장하거나 학습을 막지 않는다.
- 최소 자동 검증이 CI/로컬 명령으로 반복 가능하다.
- 환경변수와 실행법이 README에 반영된다.
- 다음 Phase가 의존할 API/DB 계약 변경을 문서에 반영한다.
- 모바일 실제 화면을 확인하고 overflow, 터치 크기, focus 문제를 수정한다.

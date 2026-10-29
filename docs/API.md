# HTTP API 설계

모든 데이터 API는 Fastify의 인증 세션에서 확인한 사용자 ID로 처리한다. 클라이언트의 userId는 소유자를 바꾸지 않는다. 응답은 JSON, 업로드는 multipart/form-data다.

## 인증·공통 규칙

- 공개 경로: health, ready, auth/session, auth/login, auth/register, auth/logout. 나머지는 인증이 필요하다.
- 변경 요청은 정확한 APP_ORIGIN이 필요하다. 누락·다른 Origin은 403이다.
- 아이디는 영문 소문자·숫자·밑줄 3~32자, 비밀번호는 유니코드 15~128자다. 비밀번호는 trim하지 않는다.
- 로그인 실패는 존재하지 않는 계정과 틀린 비밀번호 모두 같은 401이다. 유효한 세션 없는 데이터 요청도 401이다.
- 타인의 Day·학습 세션 ID는 404, 잘못된 ID 형식은 400이다. 타인의 상태를 변경하거나 작업을 생성하지 않는다.
- 중복 ID 등 충돌은 409, 크기 초과는 413, 요청·카드 한도는 429와 Retry-After다. 내부 오류 내용은 반환하지 않는다.
- POST /api/auth/login: {loginId,password}, 200과 {authenticated:true,user:{id,loginId}}, HttpOnly 인증 쿠키.
- POST /api/auth/register: {loginId,password,inviteCode}, 성공 201. 초대 소비·사용자 생성·인증 발급은 원자적이다.
- GET /api/auth/session: {authenticated,user}. 세션이 없거나 만료되면 false/null이며 토큰은 반환하지 않는다.
- POST /api/auth/logout: 현재 인증 세션 무효화와 쿠키 삭제. 반복해도 안전하다.
- 로그인 전환 후 지연된 요청을 구분하기 위한 x-chanvoca-user가 인증 사용자와 다르면 409 AUTH_CHANGED다. 이 헤더로 인증할 수는 없다.
- 업로드 한도는 사용자별 한국 날짜 기준 MAX_DAILY_CARDS다. 초과 시 Day·카드·작업을 저장하지 않는다.
- 푸시 구독은 현재 인증 세션에 연결되며 이전 계정의 유효한 구독을 빼앗을 수 없다. 로그아웃·만료 후 신규 발송은 중단된다.
- 테스트·일일 푸시 작업은 사용자·인증 세션·구독이 일치할 때만 발송한다. 기존 형식의 대기 작업은 발송하지 않는다.

## Day와 업로드

### `GET /api/days`

최신순 Day 목록과 예문 처리 현황을 반환한다.

```json
{
  "days": [
    {
      "id": "uuid",
      "dayNumber": 30,
      "originalFilename": "day30.xlsx",
      "rowCount": 50,
      "examples": { "ready": 44, "pending": 5, "failed": 1 },
      "importedAt": "2026-09-02T01:00:00.000Z"
    }
  ]
}
```

초기에는 항목 수가 작다고 보고 전체 목록을 반환한다. 수백 Day를 넘어 실제 문제가 생길 때 cursor pagination을 추가한다.

### `POST /api/days/upload`

- content type: `multipart/form-data`
- field: `file`
- 허용 확장자: `.xlsx`, `.xls`, `.csv`
- 첫 행은 무조건 header로 건너뛴다.
- 각 데이터 행의 첫 두 열만 `term`, `meaning`으로 사용한다.
- 양쪽이 모두 빈 행은 건너뛴다. 한쪽만 빈 행 또는 길이 제한 위반은 전체 업로드를 실패시키고 최대 20개 행 번호를 반환한다.
- 한 파일 내 중복과 기존 Day 중복을 모두 그대로 저장한다.

성공 `201`:

```json
{
  "day": {
    "id": "uuid",
    "dayNumber": 31,
    "rowCount": 50
  },
  "exampleJobsQueued": 50
}
```

파싱과 DB 삽입까지만 HTTP 요청에서 처리한다. LLM 예문 생성은 commit 이후 queue가 담당한다. 따라서 응답은 예문 완료를 기다리지 않는다.

업로드 전체는 원자적이다. 파싱 오류, 제한 초과, DB 오류가 발생하면 Day와 카드가 일부만 남지 않는다.

## 학습 세션

### `POST /api/study/sessions`

요청:

```json
{ "targetDayId": "uuid", "repeatOfSessionId": null }
```

`targetDayId`가 생략되면 최신 Day를 사용한다. 서버가 기준 Day의 번호 `N`에서 `[N, N-1, N-3, N-6, N-13, N-29]`를 계산하고 실제 존재하는 Day만 포함한다. 카드 집합을 고정하고 첫 라운드를 섞어 반환한다.

성공 `201`:

```json
{
  "session": {
    "id": "uuid",
    "targetDayNumber": 30,
    "planDayNumbers": [30, 29, 27, 24, 17, 1],
    "totalCards": 300
  },
  "roundNumber": 1,
  "cards": [
    {
      "id": "uuid",
      "term": "resilient",
      "meaning": "회복력이 있는",
      "exampleEn": null,
      "exampleKo": null,
      "exampleStatus": "pending"
    }
  ]
}
```

카드 ID가 고유 단위다. 동일한 단어/뜻이 여러 번 있어도 모두 배열에 포함한다.

### `GET /api/study/sessions/:sessionId`

새로고침 또는 PWA 재실행 시 진행 상태를 복구한다. 이미 통과한 카드는 제외하고 현재 라운드에 남은 카드와 통계를 반환한다. 동시에 두 탭에서 진행하는 것은 초기 버전에서 보장하지 않으며, 마지막으로 기록된 attempt를 기준으로 복구한다.

### `POST /api/study/sessions/:sessionId/attempts`

요청:

```json
{
  "idempotencyKey": "uuid",
  "cardId": "uuid",
  "roundNumber": 2,
  "position": 7,
  "result": "timeout",
  "responseMs": 10018,
  "revealedAtMs": null
}
```

서버는 해당 카드가 세션에 속하는지, 현재까지 통과하지 않았는지, 결과 enum과 시간 값이 유효한지 검사한다. 같은 idempotency key 재전송은 기존 결과를 반환한다.

성공 응답:

```json
{
  "accepted": true
}
```

### `POST /api/study/sessions/:sessionId/rounds`

현재 라운드가 끝났을 때 호출한다. 서버가 이번 라운드의 `unknown`/`timeout` 카드만 다음 라운드로 남긴다. 재출제에서는 최신 Day부터 과거 Day 순서를 유지하고 각 Day 안에서만 섞는다. 남은 카드가 없으면 세션을 `completed`로 원자적으로 전환하고 최종 통계를 반환한다.

응답에는 `completed`, 갱신된 `session`, 다음 라운드의 `roundNumber`, 남은 `cards`를 반환한다. 완료 시 `cards`는 빈 배열이다.

`전체 다시 반복하기`는 완료 세션의 카드 목록을 클라이언트에서 재활용하지 않고 `POST /api/study/sessions`에 `repeatOfSessionId`를 전달해 새 세션을 만든다. 그 시점의 같은 누적 계획 전체를 다시 snapshot한다.

## 예문 상태

예문 상태는 Day 목록과 학습 세션 카드에 함께 반환한다. 업로드가 만든 작업은 worker가 비동기로 처리하고, 성공한 예문은 카드에 한 번 저장해 재사용한다. `failed` 카드도 학습은 계속되며 화면에는 `예문 없음`으로 표시한다.

## 푸시와 알림

### `GET /api/push/config`

브라우저 푸시 구독에 필요한 VAPID 공개 키만 반환한다. 개인 키와 Groq 키는 어떤 API에서도 반환하지 않는다.

### `POST /api/push/subscriptions`

브라우저가 만든 PushSubscription의 `endpoint`, `keys.p256dh`, `keys.auth`를 저장한다. 알림 권한 요청은 반드시 사용자의 명시적 버튼 클릭 뒤 브라우저에서 수행한다.

### `DELETE /api/push/subscriptions`

현재 브라우저 구독 endpoint를 비활성화한다. body에는 endpoint를 받되 세션 사용자의 구독만 변경한다.

### `GET /api/notification-settings`

현재 활성 여부, 현지 알림 시각, 시간대, 브라우저 지원 안내에 필요한 서버 상태를 반환한다.

### `PUT /api/notification-settings`

요청:

```json
{ "enabled": true, "localTime": "21:00", "timezone": "Asia/Seoul" }
```

IANA 시간대와 `HH:mm`을 검증한다. 활성화할 때 유효한 푸시 구독이 없으면 `409 PUSH_SUBSCRIPTION_REQUIRED`를 반환한다.

### `POST /api/push/test`

설정 화면의 테스트 알림용이다. owner의 활성 구독에만 전송 작업을 넣는다.

## 내부 작업자 엔드포인트

장기 실행 worker가 DB를 직접 읽는 배포에서는 내부 HTTP endpoint가 필요 없다. 서버리스 cron을 택할 때만 `POST /api/internal/notifications/tick`을 추가하고 `Authorization: Bearer <CRON_SECRET>`을 constant-time 비교로 검증한다. 배포 방식이 정해지기 전에는 이 route를 만들지 않는다.

## 단어·뜻 수정

`PATCH /api/days/:dayId/cards/:cardId`

로그인한 사용자 소유 Day의 카드 한 건을 수정한다. 요청은 `{ "term": "apple", "meaning": "사과" }`이며 두 필드 모두 필수다. 추가 필드는 400으로 거절한다. 앞뒤 공백 제거 후 단어 1~200자, 뜻 1~1,000자(기존 업로드와 동일한 문자열 길이 기준)를 허용한다.

성공 응답: `{ "card": { "id": "UUID", "term": "apple", "meaning": "사과" } }`.
잘못된 UUID·입력은 400, 타인 소유·미존재·Day 불일치는 모두 404다. 기존 인증·Origin 검사를 적용한다.

예문·예문 작업·원본 행·학습 결과는 수정하지 않는다. 동시 수정은 마지막 유효 저장이 남는다. 중복 단어를 허용한다.

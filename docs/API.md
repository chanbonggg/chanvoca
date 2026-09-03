# HTTP API 설계

모든 응답은 `backend/`의 Fastify route가 처리한다. 응답은 JSON이며 업로드만 `multipart/form-data`를 받는다. 초기 버전에는 앱 로그인이 없고 모든 API가 DB의 단일 `owner` 범위에서 동작한다. 사용자 ID는 요청 body에서 받지 않는다.

이 API는 신뢰할 수 있는 개인 네트워크 또는 별도 접근 제한 뒤에서만 실행한다. 공인 인터넷에 직접 공개하는 배포로 바뀌면 기능 추가보다 인증 도입을 먼저 한다.

## 공통 규칙

- 성공: 필요한 최소 데이터와 적절한 2xx 상태를 반환한다.
- 검증 실패: `400`과 `{ "error": { "code", "message", "fields?" } }`.
- 충돌/중복 요청: `409`.
- 업로드 크기 초과: `413`; 지원하지 않는 형식: `415`.
- 예상하지 못한 오류: 상세 내부 정보를 감춘 `500`.
- 상태 변경 요청의 입력 형식은 route별로 검증한다. 로그인 없는 초기 버전이므로 운영에서는 반드시 VPN/Tailscale 또는 리버스 프록시 인증으로 접근을 제한한다.
- 클라이언트가 재시도할 수 있는 결과 저장 API는 `idempotencyKey`를 요구한다.

## 단일 owner 범위

- 앱 시작 시 `owner` 행 하나를 보장한다.
- API route는 공통 helper로 owner ID를 조회한다.
- 클라이언트가 전달한 user ID를 신뢰하지 않는다.
- 로그인·로그아웃·세션 API는 만들지 않는다.
- 향후 인증이 필요해지면 owner 데이터에 계정을 연결하고 보호 middleware를 추가한다.

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

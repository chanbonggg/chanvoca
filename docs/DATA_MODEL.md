# 데이터 모델

PostgreSQL 기준 논리 모델이다. 다음 단계에서 이 문서를 바탕으로 `db/migrations/0001_initial.sql`을 만들고 실제 DB에서 migration과 제약 조건을 검증한다. 모든 시간은 `timestamptz` UTC로 저장하고, 사용자 표시와 알림 계산에만 IANA 시간대를 적용한다.

실제 migration은 `backend/db/migrations/`의 단일 순서로 관리한다. 파일 이름에 소유 모듈을 표시하고, 테이블 접근 코드는 아래 모듈 경계를 따른다.

- `system`: `users` bootstrap과 schema version
- `days`: `days`, `cards`
- `study`: `study_sessions`, `study_session_cards`, `study_attempts`
- `examples`: `jobs` 중 `generate_example` 작업과 카드 예문 필드
- `notifications`: `push_subscriptions`, `notification_settings`, `send_push` 작업

여러 모듈이 같은 PostgreSQL을 사용하지만 다른 모듈 테이블에 임의 SQL을 작성하지 않는다. 모듈 간 transaction이 실제로 필요해질 때 backend application 조립부에서 명시적으로 조정한다.

## 관계 개요

```text
users 1 ── N days 1 ── N cards
  │                         │
  ├── N study_sessions 1 ── N study_attempts ── 1 cards
  ├── N push_subscriptions
  └── 1 notification_settings

cards 1 ── 0..1 example_jobs
study_sessions 0..1 ── N study_sessions (repeat_of)
```

## `users`

개인용 첫 버전에서도 소유권 경계를 명시한다.

| 열 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK, 서버 생성 |
| `display_name` | `text` | 첫 버전 기본값 `owner` |
| `timezone` | `text` | 기본 `Asia/Seoul` |
| `created_at` | `timestamptz` | 기본 `now()` |
| `updated_at` | `timestamptz` | 변경 시 갱신 |

초기 부트스트랩은 사용자 행이 없을 때 고정된 `owner`를 생성한다. 로그인은 없으며 모든 API는 이 owner ID를 서버에서 조회한다. 이후 계정 기능을 추가하면 credential/session 테이블을 별도로 만들고 이 테이블을 그대로 확장한다.

## `days`

업로드 1회가 Day 1개다. 파일 이름이나 날짜가 같아도 항상 새 행을 만든다.

| 열 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `user_id` | `uuid` | FK → `users.id` |
| `day_number` | `integer` | 사용자별 1부터 증가 |
| `original_filename` | `text` | 화면 표시와 감사 목적 |
| `source_format` | `text` | `xlsx`, `xls`, `csv` 중 하나 |
| `row_count` | `integer` | 저장한 카드 수, 0보다 큼 |
| `imported_at` | `timestamptz` | 기본 `now()` |

제약 및 인덱스:

- `UNIQUE (user_id, day_number)`
- `CHECK (day_number > 0)`
- `(user_id, imported_at DESC)` 인덱스
- Day 번호 배정과 카드 삽입은 하나의 transaction에서 처리한다.
- 동시 업로드에는 사용자별 PostgreSQL advisory transaction lock을 잡은 뒤 `max(day_number) + 1`을 계산한다.

## `cards`

중복 단어를 보존하기 위해 단어 자체에는 UNIQUE 제약을 절대 두지 않는다. 같은 Day 안의 동일한 단어/뜻도 각각 독립 카드다.

| 열 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `day_id` | `uuid` | FK → `days.id`, 삭제 시 cascade 여부는 구현 전 확정 |
| `source_row` | `integer` | 헤더 다음 행을 2로 시작해 원본 행 추적 |
| `term` | `text` | trim 후 비어 있지 않음 |
| `meaning` | `text` | 사용자 입력을 그대로 우선, trim 후 비어 있지 않음 |
| `example_en` | `text` | nullable |
| `example_ko` | `text` | nullable |
| `example_status` | `text` | `pending`, `processing`, `ready`, `failed` |
| `example_error_code` | `text` | nullable, 민감한 원문 응답 저장 금지 |
| `created_at` | `timestamptz` | 기본 `now()` |
| `updated_at` | `timestamptz` | 상태 변경 시 갱신 |

제약 및 인덱스:

- `UNIQUE (day_id, source_row)`는 원본 한 행이 두 번 저장되는 재시도 오류만 방지한다. 서로 다른 행의 중복 단어는 허용한다.
- `(day_id, source_row)` 인덱스로 원본 순서를 유지한다.
- 예문 생성 성공 후에는 일반 흐름에서 다시 enqueue하지 않는다.

## `jobs`

예문 생성과 푸시 전송을 위한 작은 PostgreSQL 작업 큐다.

| 열 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `kind` | `text` | `generate_example`, `send_push` |
| `dedupe_key` | `text` | 작업 대상별 안정적인 키 |
| `payload` | `jsonb` | card ID 또는 알림 대상 ID 등 최소 정보 |
| `status` | `text` | `queued`, `processing`, `done`, `failed` |
| `attempts` | `integer` | 기본 0 |
| `max_attempts` | `integer` | 기본 5 |
| `available_at` | `timestamptz` | 재시도 가능 시각 |
| `locked_at` | `timestamptz` | worker 장애 복구용 |
| `locked_by` | `text` | worker 식별자 |
| `last_error_code` | `text` | 정규화된 오류 코드만 저장 |
| `created_at` | `timestamptz` | 기본 `now()` |
| `completed_at` | `timestamptz` | nullable |

핵심 규칙:

- `UNIQUE (kind, dedupe_key)`로 같은 카드의 예문 작업 중복 enqueue를 막는다.
- `SELECT ... FOR UPDATE SKIP LOCKED LIMIT n`으로 여러 worker가 충돌 없이 가져간다.
- 처리 시작 후 일정 시간이 지난 `processing` 작업은 다시 `queued`로 되돌린다.
- 재시도 간격은 1분, 5분, 30분, 2시간처럼 제한된 지수 백오프를 적용한다.
- `payload`에 API 키, 원본 파일, 전체 푸시 구독을 넣지 않는다.

## `study_sessions`

사용자가 선택한 Day 기준 누적 계획 한 번을 나타낸다.

| 열 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `user_id` | `uuid` | FK → `users.id` |
| `target_day_id` | `uuid` | 선택 Day FK |
| `target_day_number` | `integer` | 삭제/변경과 무관한 표시 snapshot |
| `plan_day_numbers` | `integer[]` | 실제 포함된 Day 번호 snapshot |
| `status` | `text` | `in_progress`, `completed`, `abandoned` |
| `total_cards` | `integer` | 계획의 고유 카드 수 |
| `known_count` | `integer` | 최종 통과 카드 수 |
| `unknown_count` | `integer` | `몰랐어요` 선택 횟수 |
| `timeout_count` | `integer` | 시간 초과 횟수 |
| `rounds_completed` | `integer` | 종료된 라운드 수 |
| `repeat_of_session_id` | `uuid` | 전체 반복 시 이전 세션 FK, nullable |
| `started_at` | `timestamptz` | 기본 `now()` |
| `completed_at` | `timestamptz` | nullable |

카운트는 조회 성능을 위한 요약값이다. 진실의 원천은 `study_attempts`이며 세션 종료 transaction에서 다시 계산해 기록한다.

## `study_session_cards`

세션이 시작된 순간의 계획 카드 집합을 고정한다. 학습 중 Day가 추가되어도 진행 중 세션은 바뀌지 않는다.

| 열 | 타입 | 규칙 |
| --- | --- | --- |
| `session_id` | `uuid` | FK → `study_sessions.id` |
| `card_id` | `uuid` | FK → `cards.id` |
| `initial_order` | `integer` | 첫 라운드 셔플 순서 |
| `passed_at_round` | `integer` | 통과 전 nullable |
| `created_at` | `timestamptz` | 기본 `now()` |

PK는 `(session_id, card_id)`다. 원본 중복 단어도 카드 ID가 다르므로 각각 저장된다.

## `study_attempts`

카드 한 번 제시와 응답 하나를 기록한다.

| 열 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `session_id` | `uuid` | FK → `study_sessions.id` |
| `card_id` | `uuid` | FK → `cards.id` |
| `round_number` | `integer` | 1부터 시작 |
| `position` | `integer` | 해당 라운드 내 순서 |
| `result` | `text` | `known`, `unknown`, `timeout` |
| `response_ms` | `integer` | 카드 표시부터 결과 확정까지 |
| `revealed_at_ms` | `integer` | 카드 표시 후 뜻을 본 시점, timeout이면 nullable |
| `idempotency_key` | `uuid` | 클라이언트 재전송 중복 방지 |
| `created_at` | `timestamptz` | 서버 수신 시각 |

제약:

- `UNIQUE (session_id, idempotency_key)`
- `CHECK (round_number > 0 AND position > 0 AND response_ms >= 0)`
- 이미 통과한 카드에 이후 attempt를 쓰지 못하도록 application transaction에서 확인한다.

## `push_subscriptions`

한 사용자가 휴대폰과 데스크톱 등 여러 구독을 가질 수 있다.

| 열 | 타입 | 규칙 |
| --- | --- | --- |
| `id` | `uuid` | PK |
| `user_id` | `uuid` | FK → `users.id` |
| `endpoint` | `text` | UNIQUE |
| `p256dh` | `text` | Web Push 키 |
| `auth` | `text` | Web Push 인증 값 |
| `user_agent` | `text` | 진단용, 길이 제한 |
| `created_at` | `timestamptz` | 기본 `now()` |
| `last_success_at` | `timestamptz` | nullable |
| `disabled_at` | `timestamptz` | 404/410 응답 시 설정 |

## `notification_settings`

| 열 | 타입 | 규칙 |
| --- | --- | --- |
| `user_id` | `uuid` | PK, FK → `users.id` |
| `enabled` | `boolean` | 기본 false |
| `local_time` | `time` | 사용자가 정한 매일 시각 |
| `timezone` | `text` | IANA 이름 |
| `last_enqueued_local_date` | `date` | 같은 날짜 중복 알림 방지 |
| `updated_at` | `timestamptz` | 변경 시 갱신 |

스케줄러는 UTC 현재 시각을 각 설정의 현지 시각으로 변환해 분 단위로 비교한다. `last_enqueued_local_date` 갱신과 `send_push` enqueue는 같은 transaction에서 처리한다.

## 데이터 보존과 삭제

초기 버전에는 UI 삭제 기능을 넣지 않는다. 이후 삭제를 추가할 때 아래 정책을 먼저 확정한다.

- Day 삭제 시 과거 세션 통계를 보존할지
- 카드 원문을 snapshot으로 남길지
- 계정 삭제 시 푸시 구독과 작업 payload까지 cascade할지
- LLM 오류와 업로드 원본 파일을 얼마나 오래 보존할지

기본안은 업로드 원본 파일을 DB나 디스크에 영구 저장하지 않고, 파싱 transaction이 끝나면 폐기하는 것이다.

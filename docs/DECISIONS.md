# 기술 결정 기록

이 문서는 구현에 반영한 방향과 의도적으로 미룬 선택을 기록한다.

## 확정한 방향

### frontend/backend 분리 npm workspace

- `frontend/`는 Next.js App Router 기반 UI와 PWA만 담당한다.
- `backend/`는 Fastify 기반 HTTP API, worker, scheduler를 담당한다.
- 루트는 npm workspace만 제공한다. Turborepo/Nx 같은 추가 orchestration 도구는 쓰지 않는다.
- 프론트엔드는 항상 same-origin `/api/*`를 호출한다. 개발에서는 Next.js rewrite, 운영에서는 reverse proxy가 백엔드로 전달한다.
- Groq 키, DB URL, VAPID private key는 백엔드 환경에만 둔다.

### 백엔드 모듈형 모놀리스

- 배포 단위와 PostgreSQL은 하나지만 코드는 `system`, `days`, `study`, `examples`, `notifications` 도메인 모듈로 나눈다.
- 각 모듈은 자기 route, 규칙, query를 소유한다.
- 다른 모듈의 내부 파일을 직접 import하지 않는다. 실제 공유가 필요해질 때만 작은 공개 함수를 노출한다.
- `shared`에는 둘 이상의 모듈에서 실제 사용하는 DB 연결, 환경 설정, 공통 HTTP 오류만 둔다.
- 계층 수를 맞추기 위한 빈 controller/service/repository 파일은 만들지 않는다.

### PostgreSQL 단일 저장소

- 단어, Day, 세션, 시도 이력, 예문 작업, 푸시 구독을 PostgreSQL에 저장한다.
- 초기에는 Redis를 추가하지 않는다. 예문 작업 큐와 알림 작업도 PostgreSQL 테이블에서 `FOR UPDATE SKIP LOCKED`로 가져온다.
- 처리량이 실제로 한계에 도달하기 전에는 별도 큐 제품을 도입하지 않는다.

### SQL 우선 데이터 계층

- 스키마는 버전이 붙은 SQL migration으로 관리한다.
- 얇은 PostgreSQL 드라이버 하나만 사용하고, 도메인 모델을 다시 감싸는 Repository/Service 계층을 선행 작성하지 않는다.
- Fastify route와 worker에서 공통으로 필요한 쿼리 함수만 추출한다.

### 초기 앱 로그인 제외, 단일 owner 데이터 모델 유지

- 최초 버전에는 로그인 화면, 비밀번호, 세션을 만들지 않는다.
- 서버에는 `owner` 사용자 한 행을 만들고 모든 API가 그 owner 범위에서만 동작한다.
- 핵심 테이블에는 처음부터 `user_id`를 둔다. 나중에 계정 기능을 추가할 때 데이터 이전을 피하기 위한 최소 비용이다.
- 앱 인증이 없으므로 공개 인터넷에 직접 노출하지 않는다. 외부 접속이 필요하면 VPN/Tailscale 또는 리버스 프록시 인증을 먼저 적용한다.

### Groq 단일 공급자

- 예문 생성은 Groq API만 사용한다.
- 서버 환경변수는 `GROQ_API_KEY`, `GROQ_MODEL` 두 개만 둔다.
- API endpoint는 `https://api.groq.com/openai/v1`로 코드에 고정한다.
- 기본 모델은 `openai/gpt-oss-120b`이며 `GROQ_MODEL` 환경변수로 운영 환경에서 명시한다.
- Node.js 내장 `fetch`로 호출하고 Groq/OpenAI SDK는 우선 추가하지 않는다.

### 네이티브 웹 기능 우선 PWA

- Next.js `manifest.ts`, 직접 작성한 작은 service worker, Web Push API를 사용한다.
- 오프라인 학습은 요구 범위에서 제외한다. 서비스 워커는 설치와 푸시 수신만 담당한다.
- 모바일 앱 프레임은 순수 CSS로 구현한다. 컴포넌트/UI 프레임워크와 아이콘 패키지는 추가하지 않는다.

### 장기 실행 worker와 scheduler

- 웹 요청에서 LLM 예문을 동기 생성하지 않는다.
- 같은 `backend/` 패키지에서 API와 worker entrypoint를 분리한다. worker가 예문 큐와 알림 스케줄을 처리한다.
- 개인 서버의 같은 Compose stack에서 API와 worker를 별도 프로세스로 실행한다.

## 현재 의도적으로 제외한 항목

- 소셜 로그인, 회원가입, 비밀번호 찾기
- 앱 자체 로그인과 세션
- 관리자 페이지
- 단어 수정/삭제와 Day 재정렬
- 오프라인 학습 및 결과 동기화
- 음성 발음, TTS, 이미지 예문
- 학습 통계 대시보드
- 여러 LLM 공급자를 위한 범용 계층
- Redis, Kafka, 별도 마이크로서비스
- 전역 상태 관리 라이브러리와 서버 상태 캐시 라이브러리

이 항목들은 실제 사용에서 필요성이 확인될 때 추가한다.

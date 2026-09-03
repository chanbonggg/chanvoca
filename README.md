# ChanVoca

개인 서버에서 운영하는 영단어 암기 PWA입니다. `frontend/`와 `backend/`를 물리적으로 분리하고, 백엔드는 하나의 Fastify 배포 단위 안에서 도메인별 모듈로 나눈 모듈형 모놀리스입니다.

## 구현 상태

- `frontend/`: Next.js App Router + TypeScript PWA
- `backend/`: Fastify + TypeScript 모듈형 모놀리스
- 모바일 우선 다크 모드 학습 UI, PWA manifest·service worker(푸시 전용)
- PostgreSQL migration, 단일 owner 경계, Day 목록 API
- 누적 복습 세션·10초 타이머·정답/오답/시간 초과·반복 라운드와 DB 기록
- Groq 예문 작업 큐와 별도 worker
- 웹 푸시 구독, 매일 알림 scheduler, 알림 설정 UI
- 로컬 개발 Compose와 개인 서버용 Compose

업로드는 `.xlsx`, `.xls`, UTF-8 CSV(UTF-8 BOM 포함)를 지원합니다. 첫 행은 헤더로 건너뛰고, 첫 두 열을 영어 단어와 뜻으로 저장합니다. 완전히 빈 행은 건너뛰며 단어 또는 뜻이 비어 있는 행이 하나라도 있으면 파일 전체를 저장하지 않고 오류 행을 알려 줍니다. 중복 단어도 각각 독립 카드로 보존합니다.

```text
chanvoca/
├─ frontend/                 # Next.js App Router UI/PWA
├─ backend/                  # Fastify API + PostgreSQL worker
│  ├─ db/migrations/
│  └─ src/modules/           # system, days, study, examples, notifications
├─ docs/
├─ compose.yaml              # 로컬 PostgreSQL만 실행
└─ compose.production.yaml   # 개인 서버 전체 구성
```

## 로컬 실행

요구 사항: Node.js 22+, npm, Docker Desktop(또는 접근 가능한 PostgreSQL).

```powershell
npm install
Copy-Item frontend/.env.example frontend/.env.local
Copy-Item backend/.env.example backend/.env
docker compose up -d postgres
npm run dev:backend
```

다른 터미널에서 다음을 실행합니다.

```powershell
npm run dev:frontend
```

워크백엔드를 별도로 실행하려면 세 번째 터미널에서 `npm --workspace backend run dev:worker`를 실행합니다. 브라우저는 `http://localhost:3000`에서 엽니다. 개발 프론트엔드의 `/api/*` 요청은 `BACKEND_INTERNAL_URL`(기본 `http://localhost:4000`)로 전달됩니다.

처음 DB를 만들었거나 migration을 별도로 적용하려면 다음을 실행합니다.

```powershell
npm --workspace backend run migrate
```

## 환경변수

| 이름 | 위치 | 목적 |
| --- | --- | --- |
| `DATABASE_URL` | backend 전용 | PostgreSQL 연결 문자열 |
| `GROQ_API_KEY` | backend 전용 | Groq API 키 |
| `GROQ_MODEL` | backend 전용 | 사용할 Groq 모델 ID (`openai/gpt-oss-120b`) |
| `VAPID_PRIVATE_KEY` | backend 전용 | 웹 푸시 서명 개인 키 |
| `VAPID_PUBLIC_KEY` | backend 전용 | 서버가 검증·발송에 쓸 VAPID 공개 키 |
| `VAPID_SUBJECT` | backend 전용 | VAPID 연락처 (`mailto:` 또는 URL) |
| `BACKEND_INTERNAL_URL` | frontend 서버 전용 | Next.js가 API를 전달할 주소 |
| `APP_TIMEZONE` | backend 전용 | 기본 시간대 (기본 `Asia/Seoul`) |

`GROQ_API_KEY`, `DATABASE_URL`, VAPID 개인 키는 절대 `NEXT_PUBLIC_` 변수나 브라우저 코드에 넣지 않습니다. VAPID 공개 키는 구독 직전에 서버 API가 전달합니다.

### Groq 예문 생성 연결

1. [Groq API Keys](https://console.groq.com/keys)에서 개인 API 키를 새로 만듭니다.
2. 로컬의 `backend/.env`에서 아래 한 줄의 빈 값을 키로 바꿉니다. 키는 채팅, Git, 프론트엔드 환경변수에 넣지 않습니다.

   ```dotenv
   GROQ_API_KEY=발급받은_키
   GROQ_MODEL=openai/gpt-oss-120b
   ```

3. backend worker를 실행합니다. 업로드로 생성된 각 카드의 예문 작업을 worker가 비동기로 처리하고, 성공한 영어 예문과 한국어 해석은 카드 DB에 저장됩니다.

   ```powershell
   npm --workspace backend run worker
   ```

코드는 Groq의 `POST https://api.groq.com/openai/v1/chat/completions` API를 서버에서만 호출합니다. [Groq API reference](https://console.groq.com/docs/api-reference)를 기준으로 연결했습니다.

### 웹 푸시(VAPID) 설정

푸시 알림은 VAPID 키 쌍이 한 번 필요합니다. 아래 명령은 키를 화면에만 출력하므로, 출력값을 채팅이나 Git에 올리지 말고 `backend/.env`에 직접 넣습니다.

```powershell
node_modules\bin\web-push.cmd generate-vapid-keys --json
```

```bash
./node_modules/.bin/web-push generate-vapid-keys --json
```

출력된 `publicKey`, `privateKey`를 각각 `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`에 넣고, `VAPID_SUBJECT`에는 본인의 연락 가능한 `mailto:` 주소 또는 HTTPS URL을 설정합니다. 배포 후 HTTPS 주소에서 메뉴의 `이 기기에 알림 허용`을 눌러 권한을 부여한 뒤, 시간을 저장하고 `테스트`로 수신을 확인합니다.

## 검증 명령

```powershell
npm test
npm run lint
npm run typecheck
npm run build
```

## 개인 서버 배포

서버에서 저장소를 받은 뒤 두 환경파일을 만들고 실제 비밀값을 입력합니다. `backend/.env`는 API·Groq·VAPID 설정용이고, `.env.production`은 Compose가 PostgreSQL에 전달하는 비밀번호용입니다.

```bash
cp backend/.env.example backend/.env
cp .env.production.example .env.production
# backend/.env의 GROQ_*, VAPID_* 값을 설정
# .env.production의 POSTGRES_PASSWORD를 긴 무작위 값으로 변경
docker compose --env-file .env.production -f compose.production.yaml up -d --build
```

`compose.production.yaml`은 PostgreSQL, API, worker, Next.js를 함께 실행하고 DB 데이터는 Docker volume에 보존합니다. 공인 인터넷에 로그인 없는 앱을 그대로 노출하면 누구나 데이터를 변경할 수 있습니다. 따라서 VPN/Tailscale 또는 리버스 프록시 인증을 먼저 적용하고, HTTPS를 제공해야 PWA 설치와 웹 푸시가 정상 동작합니다. 도메인·TLS 프록시 방식이 정해지면 그 환경에 맞는 프록시 설정을 추가합니다.

## 문서

- [전체 구현 계획](./docs/PLAN.md)
- [데이터 모델](./docs/DATA_MODEL.md)
- [API 설계](./docs/API.md)
- [기술 결정](./docs/DECISIONS.md)
- [확인이 필요한 정책](./docs/OPEN_QUESTIONS.md)

# ChanVoca

개인 서버에서 운영하는 영단어 암기 PWA입니다. `frontend/`와 `backend/`를 물리적으로 분리하고, 백엔드는 하나의 Fastify 배포 단위 안에서 도메인별 모듈로 나눈 모듈형 모놀리스입니다.

## 구현 상태

- `frontend/`: Next.js App Router + TypeScript PWA
- `backend/`: Fastify + TypeScript 모듈형 모놀리스
- 모바일 우선 다크 모드 학습 UI, PWA manifest·service worker(푸시 전용)
- PostgreSQL migration, 계정별 데이터 경계, Day 목록 API
- 누적 복습 세션·10초 타이머·정답/오답/시간 초과·반복 라운드와 DB 기록
- Groq 예문 작업 큐와 별도 worker
- 웹 푸시 구독, 매일 알림 scheduler, 알림 설정 UI
- 아이디·비밀번호, 일회용 초대 가입, DB 인증 세션과 사용자별 단어장
- 로컬 개발 Compose와 개인 서버용 Compose

업로드는 `.xlsx`, `.xls`, UTF-8 CSV(UTF-8 BOM 포함)를 지원합니다. 첫 행의 word/meaning·단어/뜻 헤더를 인식해 제외하고, 헤더가 없으면 첫 행부터 단어와 뜻으로 저장합니다. 완전히 빈 행은 건너뛰며 단어 또는 뜻이 비어 있는 행이 하나라도 있으면 파일 전체를 저장하지 않고 오류 행을 알려 줍니다. 중복 단어도 각각 독립 카드로 보존합니다.

```text
chanvoca/
├─ frontend/                 # Next.js App Router UI/PWA
├─ backend/                  # Fastify API + PostgreSQL worker
│  ├─ db/migrations/
│  └─ src/modules/           # system, auth, days, study, examples, notifications
├─ docs/
├─ compose.yaml              # 로컬 PostgreSQL만 실행
└─ compose.production.yaml   # 개인 서버 전체 구성
```

## 로컬 실행

요구 사항: Node.js 24+, npm, Docker Desktop(또는 접근 가능한 PostgreSQL).

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

worker를 별도로 실행하려면 세 번째 터미널에서 `npm --workspace backend run worker`를 실행합니다. 브라우저는 `http://localhost:3000`에서 엽니다. 개발 프론트엔드의 `/api/*` 요청은 `BACKEND_INTERNAL_URL`(기본 `http://localhost:4000`)로 전달됩니다.

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
| `APP_ORIGIN` | backend 전용 | 정확한 앱 Origin. 개발은 `http://localhost:3000`, 운영은 실제 HTTPS 주소 |
| `MAX_DAILY_CARDS` | backend 전용 | 사용자별 한국 날짜 기준 일일 신규 카드 한도 (기본 5,000) |

`GROQ_API_KEY`, `DATABASE_URL`, VAPID 개인 키는 절대 `NEXT_PUBLIC_` 변수나 브라우저 코드에 넣지 않습니다. VAPID 공개 키는 구독 직전에 서버 API가 전달합니다.

### 계정 초기 설정과 초대

migration을 먼저 적용한 뒤 다음 명령으로 기존 owner 데이터에 본인 계정을 연결합니다. 새 DB에서는 첫 계정을 생성합니다. 비밀번호는 화면에 표시되지 않는 입력으로 받고 15~128자를 허용합니다. 기존 연결을 덮어쓰지 않으므로 초기 설정 명령은 한 번만 성공합니다.

```powershell
npm --workspace backend run migrate
npm --workspace backend run auth -- setup my_login
npm --workspace backend run auth -- invite
```

초대 코드는 7일간 한 번 사용할 수 있습니다. 상대방은 앱의 '초대 코드로 가입하기'에서 코드·아이디·비밀번호를 입력합니다. 코드 전달과 비밀번호 재설정은 운영자가 처리합니다. 공개 관리 API나 이메일 발송은 없습니다.

```powershell
npm --workspace backend run auth -- cancel-invite
npm --workspace backend run auth -- reset-password friend_login
```

재설정은 해당 계정의 모든 로그인을 해제합니다. 로그아웃은 현재 로그인만 해제합니다. DB에는 비밀번호의 scrypt 해시와 인증 토큰·초대 코드의 해시만 저장합니다. 인증은 최대 30일 유지되며 만료·로그아웃·재설정 후 해당 세션의 기기 푸시는 중단되고 재로그인 후 재연결됩니다.

전환 시 기존 공용 로그인 쿠키는 무효입니다. 운영 전환 절차는 [다중 사용자 계획](docs/MULTI_USER_PLAN.md)의 9절을 따르세요. 과거의 공용 비밀번호·서명 비밀값은 더 이상 사용하지 않습니다.

로그인·가입에는 Origin 검사와 DB 기반 요청 제한이 적용됩니다. 사용자 ID는 서버의 인증 세션에서만 결정합니다. 현재 Next.js 경유 요청의 IP는 백엔드에 보이는 프록시 주소를 사용하며 임의의 전달 헤더를 신뢰하지 않습니다. 따라서 IP 제한은 같은 프록시 사용자 사이에 공유됩니다. 인원이 많아지면 실제 ingress의 전달 헤더 정제·신뢰 경로를 확정한 뒤 조정해야 합니다.

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

별도 로컬 테스트 DB를 먼저 준비합니다. DB 이름은 `_test`로 끝나야 하며 앱 DB와 달라야 합니다. 통합 테스트는 데이터를 초기화하므로 실제 데이터가 있는 DB를 지정하지 마세요. 테스트 DB가 없으면 skip 대신 실패합니다.

```powershell
$env:TEST_DATABASE_URL='postgres://chanvoca:chanvoca@localhost:5432/chanvoca_test'
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
# backend/.env의 GROQ_*, VAPID_*, APP_ORIGIN(실제 HTTPS Origin)을 설정
# .env.production의 POSTGRES_PASSWORD를 긴 무작위 값으로 변경
docker compose --env-file .env.production -f compose.production.yaml up -d --build
```

`compose.production.yaml`은 PostgreSQL, API, worker, Next.js를 함께 실행하고 DB 데이터는 Docker volume에 보존합니다. 앱은 계정 인증 세션이 있는 브라우저에만 자기 데이터의 API를 허용합니다. Nginx Basic Auth 또는 Cloudflare Access를 함께 쓸 필요는 없으며, HTTPS를 제공해야 PWA 설치와 웹 푸시가 정상 동작합니다.

별도 프록시 인증을 사용하던 서버는 계정 로그인과 데이터 분리 확인을 마친 뒤에만 기존 접근 제한 변경을 검토하세요.

```nginx
auth_basic ...;
auth_basic_user_file ...;
```

변경 후 `sudo nginx -t`로 문법을 확인하고 `sudo systemctl reload nginx`로 적용합니다. 아이폰 홈 화면 앱은 기존 아이콘을 삭제한 뒤 Safari에서 새로 추가하면 됩니다.

## 문서

- [전체 구현 계획](./docs/PLAN.md)
- [데이터 모델](./docs/DATA_MODEL.md)
- [API 설계](./docs/API.md)
- [기술 결정](./docs/DECISIONS.md)
- [확인이 필요한 정책](./docs/OPEN_QUESTIONS.md)

운영 이미지의 CLI는 backend 컨테이너에서 `node dist/modules/auth/auth.cli.js setup my_login`, `invite`, `cancel-invite`, `reset-password friend_login`으로 실행합니다. 개발용 `tsx`가 없는 운영 이미지에서도 사용할 수 있습니다. 운영 배포와 migration은 백업·복원 확인 후 사용자가 수행합니다.

푸시 구독의 발송 주소는 Google FCM, Mozilla Push, Apple Push, Windows WNS의 HTTPS 호스트만 허용합니다. 내부 IP·임의 URL로 서버가 요청하지 않도록 저장 시와 발송 시 모두 확인합니다. 새 공급자가 필요하면 허용 목록과 테스트를 함께 변경합니다.

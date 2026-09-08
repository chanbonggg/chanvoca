# 백엔드 로그 사용법

API, 워커, 마이그레이션은 표준 출력에 한 줄 단위 JSON 로그를 남긴다. 별도 로그 파일은 만들지 않는다. 배포 환경의 컨테이너 로그 수집 및 보존 설정을 사용한다.

## 오류 위치 찾기

1. API 응답 헤더 `x-request-id`를 확인한다. 서버가 생성하므로 클라이언트가 보낸 ID로 덮어쓰지 않는다.
2. 로그의 `reqId`로 해당 요청을 찾는다. `http.error`의 `stage`, `err.code`, `err.stack`에서 실패 단계와 파일·행 번호를 확인한다.
3. 예문 생성 및 테스트 푸시 작업은 요청의 ID를 작업 payload의 `traceId`로 저장한다. 워커의 `traceId`를 같은 값으로 검색하면 요청 이후 비동기 작업까지 추적할 수 있다. 변경 전에 생성된 작업에는 이 값이 없다.
4. 개별 작업은 `jobId`, `kind`, `attempt`, `maxAttempts`로 찾는다. `job.failed`의 `willRetry`는 재시도 여부이며, `job.unexpected_error`는 기존의 15분 stale 복구 대상이다.
5. 예외 없이 반환한 400/404/409/413/503 응답도 `http.rejected`에 상태와 애플리케이션 오류 코드가 남는다. 예외 로그와 응답 로그는 서로 다른 이벤트이다.

```powershell
docker compose -f compose.production.yaml logs --since 30m backend worker |
  Select-String '요청-ID-또는-작업-ID'
```

## 로그 범위

| 영역 | 기록 내용 |
| --- | --- |
| HTTP 전체 | 시작·완료, 메서드·라우트 패턴, 요청 ID, 상태, 소요 시간, 예외·타임아웃·중단 |
| 업로드 | 파싱 결과, 크기·형식·행 수, 오류 행 번호, DB 저장 단계, 커밋된 Day와 작업 수 |
| 학습 | 세션 생성, 시도 처리 결과·중복, 카드 ID·라운드, 라운드 및 세션 완료 |
| 알림 | 구독 저장·해제, 설정 변경, 테스트 큐, 일일 예약 커밋, 전송 결과·만료 구독 해제 |
| 예문 | Groq 호출 단계, HTTP 상태·소요 시간, 결과 검증, 카드 저장·실패·건너뛰기 |
| 워커 | 시작·종료, 작업 확보·시도·완료·재시도·최종 실패, stale 작업 복구 |
| DB | 호출 전 실행 단계, DEBUG에서 쿼리 해시·명령 종류·파라미터 수·연결 ID |
| 마이그레이션 | 개별 파일 이름, 시작·커밋·소요 시간·실패 스택 |

`stage` 값을 소스에서 검색하면 해당 작업 직전 코드로 이동할 수 있다. SQL 해시는 같은 쿼리를 묶는 식별자이며 SQL 실행 시간이나 성공을 의미하지 않는다. 트랜잭션 커밋 실패 시 마지막 실행 단계가 표시될 수 있으므로 오류 스택도 함께 확인한다.

## 상세 수준과 소스 위치

기본값은 `LOG_LEVEL=info`이다. `backend/.env`에서 `LOG_LEVEL=debug`로 바꾸고 API와 워커를 재시작하면 DB 호출과 각 실행 단계까지 기록한다. 일상 운영에는 `info`, 상세 진단에는 `debug`를 사용한다. `warn`, `error`, `fatal`, `silent`도 지원한다.

Docker 이미지와 `npm start --workspace backend`는 소스맵을 활성화한다. 빌드 결과를 직접 실행한다면 `node --enable-source-maps dist/server.js` 또는 `node --enable-source-maps dist/worker.js`를 사용한다. `.js.map` 파일도 함께 배포해야 TypeScript 원본 파일·행 번호가 표시된다.

비밀번호·토큰·쿠키·요청/응답 본문·푸시 endpoint 및 키·파일 내용·SQL 원문과 파라미터는 기록하지 않는다. 드라이버 오류 메시지와 detail에도 실제 데이터가 포함될 수 있어 오류는 타입·코드·상태·스택 프레임 및 원인 스택만 기록한다. 오류의 첫 줄 메시지를 제외해도 파일·함수·행 번호는 유지한다. 알림 전송 성공은 공급자의 접수를 의미하며 사용자 기기의 수신 보장은 아니다.

## 검증

`npm run typecheck --workspace backend`, `npm run test --workspace backend`, `npm run build --workspace backend`로 확인한다. 로그 테스트는 동시 요청의 컨텍스트 분리, 오류 단계 및 원본 위치, 처리된 DB 실패, 검증 거절, 민감정보 제외를 검사한다. 기존 DB 통합 테스트는 전용 테스트 DB의 `TEST_DATABASE_URL`이 있어야 실행된다.

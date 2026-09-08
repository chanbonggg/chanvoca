# 프론트엔드 로그

프론트엔드 서버 로그는 JSON 한 줄 단위로 표준 출력에 남는다. 브라우저의 처리된 오류와 주요 작업은 `/api/client-logs`로 전송되어 같은 컨테이너에 `browser.*` 이벤트로 기록된다.

## Ubuntu에서 확인

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}'
docker logs -f --tail=100 실제프론트엔드컨테이너이름
```

Compose 환경 변수가 설정되어 있다면 세 서비스를 동시에 볼 수 있다.

```bash
docker compose --env-file 실제배포환경파일 -f compose.production.yaml logs -f --tail=100 frontend backend worker
```

## 업로드 오류 추적

1. `browser.upload.started`: 사용자가 파일을 선택했다. 크기와 허용 확장자만 기록한다.
2. `proxy.started`: 프론트엔드 서버가 API 요청을 받았다.
3. `proxy.response`: 백엔드가 HTTP 응답 헤더를 반환했다.
4. `proxy.completed`: 백엔드 응답 본문까지 읽었다. 실제 브라우저 수신 완료를 의미하지 않는다.
5. `browser.upload.completed`: 브라우저에서 업로드 성공 결과를 처리했다.

실패 시 `proxy.failed`의 `stage`, `statusCode`, `errorCode`, `causeCode`, `stack`을 확인한다. `proxy.read_body`는 업로드 수신, `proxy.connect_backend`는 연결/응답 대기, `proxy.read_response`는 응답 본문 수신 단계다. 예: `causeCode=ECONNREFUSED`는 백엔드 연결 거부다.

`clientRequestId`로 브라우저 요청과 프론트엔드 로그를 찾고, `frontendRequestId`로 프론트엔드의 처리 기록을 묶는다. `backendRequestId`는 백엔드의 `reqId`와 같으며, 이후 워커의 `traceId`까지 연결된다. 화면의 API 오류에도 HTTP 상태와 프론트엔드 추적 ID가 표시된다. 앞단에서 실패해 프론트엔드 ID가 없으면 브라우저 요청 ID를 표시한다.

`proxy.started`조차 없으면 요청이 이 프론트엔드까지 도달했는지, 다른 컨테이너 로그를 보는지, 외부 프록시에서 거절되었는지 브라우저 Network와 외부 프록시 로그로 확인한다. 외부 프록시/Nginx의 오류는 애플리케이션이 직접 기록할 수 없다.

## 전체 기록 범위

| 영역 | 이벤트 |
| --- | --- |
| 모든 API 호출 | 브라우저 시작·응답·완료·실패, 서버 전달 단계·상태·시간·크기 |
| 업로드 | 시작·성공·실패, 파일 크기·형식, Day ID·행 수 |
| 학습 | Day 목록, 세션 적용·복원·복원 실패, 답변 저장·라운드 진행·처리 오류 |
| 알림 설정 | 권한 요청·결과, 서비스워커 대기·준비, 구독·설정 저장·테스트 큐 |
| 서비스워커 | 등록, 알림 표시·클릭 처리의 성공·실패 |
| 브라우저 전역 | 초기화, JavaScript 오류, 처리되지 않은 Promise 거절, 리소스 로드 실패, 온라인·오프라인 |
| React/Next 서버 | 화면 렌더링 오류 경계, 루트 레이아웃 오류, 서버 요청 오류, 서버 시작 |

## 설정 및 배포

서버는 `LOG_LEVEL=info`가 기본이고 `debug`일 때 업로드 본문 수신 크기 등 중간 로그를 추가한다. 브라우저 콘솔의 DEBUG는 빌드 시 `NEXT_PUBLIC_LOG_LEVEL=debug`로 활성화한다. 브라우저 DEBUG 로그는 서버로 전송하지 않는다.

API 전달은 기존 rewrite 대신 Route Handler에서 수행한다. `BACKEND_INTERNAL_URL`은 이제 실행 시 읽으며, Docker와 배포 Compose는 `http://backend:4000`을 사용한다. 로컬 기본값은 `http://localhost:4000`이다. API 전달은 30초 제한, 요청 본문은 멀티파트 부가 정보를 포함해 11 MiB 제한이다. 실제 파일 10 MiB 제한과 파일 검증은 백엔드가 유지한다. 현재 JSON API를 위한 구현이며 SSE/WebSocket 전달용은 아니다.

변경된 프론트엔드 이미지를 다시 빌드하고 컨테이너를 재생성해야 적용된다. 브라우저도 새로고침한다. 서버 소스맵을 생성하고 Docker에서 `--enable-source-maps`를 활성화한다. Next.js 실행 경로에 따라 서버 스택에도 빌드된 청크 위치가 표시될 수 있으며, 이때 `stage` 값을 소스에서 검색해 실패 구간을 찾는다. 브라우저 프로덕션 오류는 배포된 JS 청크의 파일·행·열을 기록한다. 브라우저 원본 TypeScript 소스맵은 공개하지 않으므로 브라우저 스택이 항상 TS 원본 위치를 가리키지는 않는다.

## 민감정보와 수집 한계

요청·응답 본문, 파일 이름·내용, 쿠키·인증 헤더, 푸시 키·endpoint, URL 쿼리, 오류 메시지 원문은 기록하지 않는다. 진단 필드만 허용하고 스택에서 파일 이름·행·열만 추출한다. 브라우저 수집 이벤트는 신뢰할 수 없는 클라이언트 보고이므로 `browser.*`로 구분한다.

브라우저 로그는 약 1초 단위로 최대 20개씩 보내며 한 요청은 14 KB 미만이다. 탭당 분당 최대 100개를 전송하고 일반 정보는 80개까지로 제한해 오류 수집 여유를 둔다. 서비스워커는 분당 30개까지 전송한다. 수집 서버는 16 KiB·20개 제한과 프로세스당 분당 300회 요청 제한을 적용한다. 초과 기록은 버린다. 이 제한은 일반 API 서버 로그에 적용되지 않는다.

로그 전송 실패는 재시도하거나 다시 보고하지 않는다. 오프라인·브라우저 종료·차단 확장 프로그램·전송량 제한 때문에 브라우저 로그가 컨테이너에 도착하지 않을 수 있다. 이때 브라우저 콘솔/Network를 함께 확인한다. 정상 API 요청 로그는 서버에서도 독립적으로 남는다.

## 검증 명령

```bash
npm run test --workspace frontend
npm run lint --workspace frontend
npm run typecheck --workspace frontend
npm run build --workspace frontend
```

테스트는 실제 HTTP 서버로 멀티파트 전달·추적 ID 연결·민감정보 제외를 확인하고, 연결 실패·HTML 오류 응답·수집 용량 제한을 검사한다.

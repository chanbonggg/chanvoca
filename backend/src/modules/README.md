# Backend modules

백엔드는 하나의 프로세스와 하나의 PostgreSQL을 사용하는 모듈형 모놀리스다.

| 모듈 | 소유 책임 |
| --- | --- |
| `system` | health/readiness와 프로세스 상태 |
| `days` | 파일 업로드, Day 번호, 카드 원본 |
| `study` | 누적 계획, 세션, 라운드, 학습 결과 |
| `examples` | Groq 예문과 PostgreSQL 작업 큐 |
| `notifications` | 푸시 구독, 알림 설정, scheduler |

아직 구현하지 않은 모듈 디렉터리는 미리 만들지 않는다. 기능 구현을 시작할 때 해당 모듈 안에 route와 도메인 로직을 함께 추가한다. 모듈이 다른 모듈의 내부 파일을 직접 가져오지 않으며, 실제 공유가 생길 때만 작은 공개 함수를 `index.ts`로 노출한다.

`shared`에는 DB 연결, 환경변수 읽기, 공통 HTTP 오류처럼 두 개 이상의 모듈에서 실제로 쓰는 코드만 둔다.


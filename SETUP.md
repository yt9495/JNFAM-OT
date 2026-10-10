# JNFAM OT — 설치 가이드 (Google Sheet 백엔드)

## 1. 데이터 시트 + Apps Script
1. Google Drive에서 새 스프레드시트 생성 → 이름: `JNFAM OT Data`
2. 확장 프로그램 › Apps Script → 기본 `Code.gs` 내용을 지우고 **Code.gs 파일 전체** 붙여넣기 → 저장
3. 함수 선택 `setup` → 실행 → 권한 승인 (스프레드시트 / 메일 발송)
   - Employees, Requests, Holidays, Settings, Docs, Log 탭이 생성됩니다
4. 함수 선택 `testTimeClock` → 실행 → 로그에 "Time Clock punches in last 31 days: N" 이 나오면 출퇴근 시트 연동 OK
   - Time Clock 시트(출퇴근 기록 Time Clock ET)에 접근 권한이 있는 같은 계정으로 실행해야 합니다
5. 배포 › 새 배포 › 유형: 웹 앱
   - 실행 사용자: **나(Me)** / 액세스 권한: **모든 사용자(Anyone)**
   - 배포 후 나오는 `https://script.google.com/macros/s/…/exec` URL 복사

## 2. 프론트엔드 연결
`index.html` 상단의
```js
window.OT_CONFIG = { API_URL: '' };
```
에 위 URL을 넣으면 실서비스 모드, 비워두면 데모 모드입니다.

## 3. 첫 로그인 후 할 일 (관리 탭)
- `admin / 1234` 로그인 → 직원별 **이메일·시급·권한(승인자)** 입력, Time Clock 이름이 출퇴근 시트 "이름 (Name)"과 같은지 확인
- 직원 기본 PIN은 `0000` → 각자 상단 "PIN 변경"
- 회사 휴일(1.5배 적용일), CPA 이름/이메일, 앱 주소(메일 링크) 입력

## 참고
- 코드를 수정하면 Apps Script에서 **배포 관리 › 수정 › 새 버전**으로 재배포해야 반영됩니다
- 승인 시각은 서버(ET) 시간으로 기록 → 시작 시각 이후 승인은 자동 거부·만료
- 모든 처리 이력은 Log 탭에 남습니다

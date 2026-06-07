<div align="center">

# ⭐ StarHub

**All-in-One 개발运维 데스크톱 허브**

데이터베이스 클라이언트 · SSH/SFTP · Docker 패널 · AI 어시스턴트 · 한 창에 네이티브 데스크톱 앱

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-v0.3.0-cyan)]()
[![Status](https://img.shields.io/badge/status-MVP%20active-brightgreen)]()

</div>

---

## ✨ 프로젝트 소개

**StarHub** 는 Windows / macOS / Linux 크로스 플랫폼 데스크톱 앱으로, 개발운영 일상의 여러 도구를 한 창에 통합:

- 🗄️ **데이터베이스 클라이언트** — MySQL / Redis (포커스) + 추가로 PostgreSQL / SQLite / ClickHouse / SQL Server / Oracle / 국산 DB(达梦 / 金仓 / OceanBase / OpenGauss) — 추후 지원
- 🖥️ **SSH 터미널** — russh 풀기능 터미널, xterm.js 렌더링, 점프 호스트(프록시 점프), UTF-8 / 컬러 지원
- 📁 **SFTP 파일 전송** — 3단 브라우저, 경로 브레드크럼(클릭으로 점프), 숨김 파일 토글, 폴더 생성, 이름 변경, 삭제
- 🐳 **Docker 패널** — 컨테이너 / 이미지 리스트, 로그 조회, SSH 터널로 원격 Docker 접속(개발 중)
- 🤖 **AI 어시스턴트** — OpenAI 호환 프로토콜, Function Calling 으로 SSH / DB / Docker 조작, 명령어 자동 실행, 화이트리스트 + 위험 명령 강제 확인, 각 탭 독립 채팅 히스토리

> "Navicat + Xshell + Portainer + 파일 탐색기" 를 한 책상에 띄워놓는 번거로움을 작별.

---

## 🛠️ 기술 스택

| 레이어 | 선택 | 비고 |
|---|---|---|
| 데스크톱 셸 | **Tauri 2** (Rust) | 볼륨 5× 작음, 메모리 50% 절약, 네이티브 권한 모델 |
| 프론트엔드 | **Vue 3.4 + Vite 5 + TypeScript** | Composition API, xterm.js, Pinia |
| UI 스타일 | **Cyber Command Center** 자체 디자인 시스템 | cyber.css 디자인 토큰 (cyan 강조색 + 다크 테마) |
| 상태 관리 | **Pinia** | `pinia-plugin-persistedstate` 로 localStorage 영속화 |
| 메인 프로세스 | **Rust** (tokio + russh + bollard) | SSH / SFTP / Docker / 시스템 통합 |
| 사이드카 | **Go 1.22+** (pgx / go-redis) | 데이터베이스 드라이버, 스트리밍 쿼리, 임포트/엑스포트(계획) |
| 영속화 | **SQLite** (sqlx) + 시스템 Keyring | 로컬 자산, 암호화 키 |
| LLM | **OpenAI 호환 프로토콜** (커스텀 URL + 모델) | GPT / Claude / DeepSeek / Qwen / Ollama 모두 호환 |

---

## 🎯 v0.3.0 주요 기능 (현재)

### 멀티 탭 동시 세션
- 같은 자산이라도 **여러 탭 = 여러 독립 세션**(예: TEST 탭 2개 = 동시 SSH 2개)
- 각 탭 인스턴스 ID 로 백엔드 세션 라우팅 → 동시 사용 가능
- `⌘P` 명령 팔레트로 자산 / 탭 / 액션 빠르게 점프

### SSH 터미널
- 4색 xterm.js 풀기능 터미널
- 빠른 명령 바 (`ls` / `pwd` / `df` / `top` / `whoami` / `uptime`)
- 점프 호스트 (프록시 점프) 지원
- 재접속 / Enter 키로 재접속

### SFTP 브라우저
- 3단 레이아웃(상위 / 현재 / 액션)
- 경로 브레드크럼 클릭 점프 + 더블클릭으로 직접 편집
- 숨김 파일 / 새 폴더 / 새로고침 / 이름 변경 / 삭제

### AI 어시스턴트
- **OpenAI 호환 API**(커스텀 baseUrl / model / API Key) — GPT / DeepSeek / Qwen / Ollama / Claude(프록시) 모두 동작
- **Function Calling**: SSH 명령 / DB 쿼리 / Docker 조작 자동 실행
- **명령 안전장치**:
  - 위험 명령 하드코딩(30+ 패턴: `rm -rf` / `DROP` / `shutdown` / `iptables -F` 등) — **화이트리스트로 우회 불가능**
  - 화이트리스트: 일반 조회 명령(`ls`, `cat`, `df -h`, `docker ps` 등) 자동 통과
  - 위험 / 비화이트리스트 명령은 사용자 확인 필요
- **명령은 터미널에 직접 타이핑** + 출력 자동 수집 → AI 가 후속 작업에 활용
- **각 탭 독립 채팅 히스토리** — 탭 닫기 전까지 유지
- **설정 → AI** 에서 화이트리스트 / timeout / temperature / model 자유 편집 + 연결 테스트

### 글로벌 명령 팔레트 `⌘P`
- 자산 검색, 탭 전환, 액션(새 연결 / 설정 / 테마 / 언어) 한 곳에서
- 키보드 ↑↓ + Enter

### 다크 / 라이트 + 4색 액센트
- 액센트: Cyan(기본) / Purple(Neon) / Green(Matrix) / Orange(Sunset)
- 설정 → AI 탭 → 외관 탭에서 토글

### 그 외
- 사이드바: 자산 그룹 접기/펴기, 즐겨찾기, **연결 상태 3단**(never / recent / stale) + 마지막 사용 시간(`5m` / `2h` / `어제`)
- 사이드바 우측 드래그로 폭 조절
- `Ctrl + B` 사이드바 접기/펴기
- 라이트/다크 즉시 전환, 애니메이션

---

## ⌨️ 단축키

| 단축키 | 동작 |
|---|---|
| `Ctrl/⌘ + K` | 자산 검색(상단 검색창 포커스) |
| `Ctrl/⌘ + P` | 글로벌 명령 팔레트 |
| `Ctrl/⌘ + B` | 사이드바 접기/펴기 |
| `Ctrl/⌘ + W` | 현재 탭 닫기 |
| `Enter` (터미널) | 명령 전송 / 재접속 |
| `Ctrl + Enter` (터미널) | 줄바꿈(멀티라인) |
| 더블클릭 (탭) | 닫기 |
| 중간 클릭 (탭) | 닫기 |
| 우클릭 (탭) | 컨텍스트 메뉴 |

---

## 📦 빌드 & 실행

```bash
# 1. 의존성 설치
npm install

# 2. dev 모드 (Vite + Tauri)
npx tauri dev          # 또는 cargo tauri dev

# 3. 프로덕션 빌드
npx tauri build        # 플랫폼별 인스톨러 생성
```

빌드 산출물:

- Windows: `src-tauri/target/release/bundle/nsis/*.exe`
- macOS: `src-tauri/target/release/bundle/dmg/*.dmg`
- Linux: `src-tauri/target/release/bundle/{deb,rpm,appimage}/*`

---

## 📚 문서

- 📐 [완전 아키텍처 다이어그램](./docs/架构图.html) — 5 레이어 아키텍처, 프로세스 모델, 데이터 흐름, 기술 선택
- 📋 [완전 기술方案](./docs/技术方案.md) — 14 장 기술 세부사항, 280+ 서브 기능 리스트 (P0/P1/P2/P3 우선순위 포함)
- 📝 [업데이트 로그](./CHANGELOG.md)
- 🤖 [AI Agent 협업 가이드](./AGENTS.md) — AI 코딩 어시스턴트를 위한 프로젝트 컨벤션

---

## 🗓️ 로드맵

| 단계 | 상태 | 설명 |
|---|---|---|
| v0.1 | ✅ | 프로젝트 스캐폴딩 (Tauri + Vue + Go) |
| v0.2 | ✅ | 문서 확정 (AGENTS.md / 기술方案) |
| **v0.3** | **🚧 현재** | **SSH 터미널 + SFTP + MySQL/Redis + AI 어시스턴트 + UI 폴리시** |
| v0.4 | 🔜 | PostgreSQL / SQLite / Docker 풀기능 |
| v0.5 | 🔜 | 추가 DB 10종 + 알림 + Compose |
| v1.0 | 🔮 | GA — 팀/엔터프라이즈 기능 |
| v1.0+ | 🔮 | 플러그인 마켓 / 모바일 / 프라이빗 배포 |

---

## 🤝 참여

현재 v0.3 개발 중, Issue / PR 환영.

- **요구사항 / 피드백**: GitHub Issue
- **PR 제출**: 먼저 Issue 로 논의 후 작업 시작
- **코딩 규칙**: [AGENTS.md](./AGENTS.md) 참조
- **보안 취약점**: 메일로 비공개 연락(공개 Issue 금지)

---

## ⚠️ 보안 주의

- DB / SSH 비밀번호는 로컬에 **평문 저장**(v0.5 에서 시스템 Keyring + AES-GCM 암호화 예정)
- AI API Key 도 localStorage 평문 저장 → **타인과 PC 공유 금지**
- AI 가 실행한 모든 명령은 **터미널에 직접 표시**(투명성)
- 위험 명령(삭제 / 포맷 / 방화면 등)은 시스템 규칙으로 **강제 확인**

---

## 📄 License

본 프로젝트는 [MIT License](./LICENSE) 오픈소스.

Copyright © 2026 StarHub Authors

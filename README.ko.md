# HerdRabbit

[English](README.md) | 한국어

HerdRabbit은 [Herdr](https://herdr.dev/) 세션을 폰, 태블릿, 다른 PC의 브라우저에서 열어 줍니다. 패인을 보고 입력할 수 있고, 에이전트(Claude Code, Codex, OpenCode, Kiro CLI, Antigravity CLI)를 채팅처럼 읽고 질문에 답할 수 있습니다. 에이전트가 답을 기다리거나 일을 마치면 알림을 받습니다. PWA로 설치됩니다.

> [!IMPORTANT]
> 한 사람이 자기 Herdr 세션에 접속하는 개인용 도구입니다. Tailscale로만 접속하고 공용 인터넷에 열지 마세요.

여기 없는 내용은 전체 안내서 [docs/guide.ko.md](docs/guide.ko.md)에 있습니다.

## 설치

Linux나 macOS, Node.js 22 이상, Git이 필요합니다. [Tailscale](https://tailscale.com/)은 이 PC와 페이지를 열 기기 양쪽에 있어야 합니다. Herdr가 없거나 오래됐으면 설치 스크립트가 설치하거나 업데이트합니다.

```bash
curl -fsSL https://raw.githubusercontent.com/jwgung/HerdRabbit/main/install.sh | sh
```

HerdRabbit을 Herdr 플러그인으로 설치하고 비밀번호를 묻습니다(비워 두면 쓰지 않음). Tailscale이 돌고 있으면 tailnet 전용 HTTPS 주소도 등록하고 알려 줍니다. 이후 HerdRabbit은 Herdr와 함께 시작합니다.

Herdr가 이미 있으면 아래 명령도 같은 플러그인을 설치합니다. 포트·비밀번호·Tailscale 설정 단계만 빠집니다.

```bash
herdr plugin install jwgung/HerdRabbit
```

예전 systemd 서비스로 설치한 PC는 위 설치 스크립트가 플러그인으로 옮겨 줍니다([자세히](docs/guide.ko.md#기존-설치에서-플러그인으로-옮기기)).

## 열기

1. 같은 tailnet에 로그인한 기기에서 설치 스크립트가 알려 준 HTTPS 주소(`https://my-pc.your-tailnet.ts.net:38787` 같은)를 엽니다. 다시 보려면 `herdr plugin pane open --plugin herdrabbit --entrypoint connect`를 실행합니다. `qrencode`가 있으면 QR 코드도 그려 줍니다.
2. 앱으로 설치합니다: iPhone·iPad Safari에서는 **홈 화면에 추가**, Chrome·Edge에서는 **앱 설치**.
3. 로그인한 뒤, 페이지가 권하면 Passkey를 등록합니다.

비밀번호를 정하거나 바꾸려면 `herdr plugin pane open --plugin herdrabbit --entrypoint password`를 실행합니다.

## 다른 PC 연결

여러 PC에 HerdRabbit이 있으면 한 PC의 페이지에서 다른 PC의 세션도 볼 수 있습니다. PC **A**에서 PC **B**를 보려면:

**B에서** 한 번만 합니다. B의 페이지에서 **⚙ Settings → PCs → Let other PCs connect → Choose PCs…**를 열고 **All my PCs**를 그대로 둔 채 B의 비밀번호를 넣고 **Save**를 누릅니다. B의 HerdRabbit이 다시 시작하며, 내 Tailscale 계정으로 로그인한 모든 기기에 Connect PC 포트를 엽니다. 나중에 PC를 더 붙여도 B에서는 할 일이 없습니다. 특정 기기만 허용하려면 **Only these**에서 체크합니다. B에 비밀번호가 설정돼 있어야 합니다. 비밀번호가 없거나 터미널로 하려면 [안내서](docs/guide.ko.md#herdrabbit이-도는-다른-pc-connect-pc)를 보세요.

**A에서** 사이드바의 이 PC 줄 `⋯` 메뉴에서 **Connect PC…**를 고르고, B(**Ready**로 표시)를 골라 **Test connection** 뒤 **Save**를 누릅니다.

한 방향입니다. A의 페이지에 B가 나타나고, B의 페이지는 그대로입니다. 자세한 내용: [Connect PC](docs/guide.ko.md#herdrabbit이-도는-다른-pc-connect-pc).

## 업데이트

페이지의 **⚙ Settings → Updates**에서 모든 PC의 HerdRabbit과 Herdr를 업데이트합니다. 비밀번호를 정해 두면 플러그인도 함께 합니다. 페이지를 열 때마다, 또는 **Check**를 누르면 확인합니다.

## 설정

HerdRabbit 설정은 플러그인의 `.env` 파일에 있습니다. `herdr plugin config-dir herdrabbit`가 폴더를 알려 줍니다. 바꾼 뒤에는 `herdr plugin action invoke herdrabbit.restart`로 다시 시작합니다. 모든 설정 항목은 [환경 변수](docs/guide.ko.md#환경-변수)에 있습니다.

## 문제가 생기면

- **페이지가 안 열림:** `tailscale serve status`와 `herdr plugin action invoke herdrabbit.status`를 확인합니다. [문제 해결](docs/guide.ko.md#문제-해결)을 보세요.
- **비밀번호를 잊음:** 위의 비밀번호 패인으로 새로 정합니다.
- **Connect PC 목록에 B가 없고 "other PCs with nothing to connect to" 개수에만 들어감:** B의 Connect PC 포트가 닫혀 있습니다. 위의 B 단계를 하세요. B가 "이 PC를 허용하지 않음"으로 나오면 B에서 All my PCs를 고르거나 A를 체크하세요.

## 더 보기

- [전체 안내서](docs/guide.ko.md): 모든 기능, 설정, 보안, 문제 해결
- [Herdr 기능 중 페이지에서 되는 것](docs/herdr-coverage.ko.md)
- [디자인 규칙](docs/design.md)과 [공용 UI 키트](public/ui/README.md)
- 개발: `npm run verify`, 브라우저 검사는 `npm run check:browser`

## 라이선스

[MIT](LICENSE). 제3자 고지: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

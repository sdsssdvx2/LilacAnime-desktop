## Linux 지원

- Linux용 AppImage를 새로 제공합니다 (x64 · arm64). 실행 권한을 주고(`chmod +x`) 실행하면 됩니다.
- AppImage로 실행하면 **설정 > 업데이트 · 정보**에서 새 버전을 받아 그 자리에서 바꾸고 다시 시작합니다.
- 로컬 AI 번역(llama.cpp)은 Linux에서 Vulkan으로 돌고, NVIDIA 그래픽카드면 CUDA를 먼저 씁니다.
- 자막 기본 폰트로 Noto Sans CJK · 나눔 글꼴을 찾아 씁니다. 7z/RAR 자막은 `bsdtar`가 있으면 풉니다.
- Ubuntu 24.04 이상에서 열리지 않으면 README의 Linux 항목(libfuse2, AppArmor)을 참고해 주세요.

## 플레이어

- 키보드 ←/→로 앞뒤로 넘길 때 아래 컨트롤 바가 올라오지 않습니다. 대신 넘긴 쪽에 "+10초"와 이동한 시각이 잠깐 표시되고, 연달아 누르면 +20초, +30초로 더해집니다.
- 숫자 키 0–9로 이동할 때는 화면 가운데에 시각만 표시됩니다.

## 검증

- 자동 테스트 284개 통과.
- GitHub Actions에서 Windows · Mac(Apple Silicon · Intel) · Linux(x64 · arm64) 빌드 성공.
- 앱에서 ←/→ 이동 시 컨트롤 바 없이 표시만 뜨는 것 확인.

## 다운로드

- Windows: `LilacAnime-Setup.exe`
- Mac Apple Silicon: `LilacAnime-mac-arm64.dmg`
- Mac Intel: `LilacAnime-mac-x64.dmg`
- Linux x64: `LilacAnime-linux-x86_64.AppImage`
- Linux arm64: `LilacAnime-linux-arm64.AppImage`

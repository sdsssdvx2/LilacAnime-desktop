#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <algorithm>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <sstream>
#include <string>
#include <thread>
#include <vector>

struct Hole {
  int x{};
  int y{};
  int w{};
  int h{};
};

struct BoundsCommand {
  int x{};
  int y{};
  int w{1};
  int h{1};
  bool visible{true};
  std::vector<Hole> holes;
};

static constexpr UINT WM_HOST_COMMAND = WM_APP + 77;

static uintptr_t ParseHandle(const char* value) {
  if (!value || !*value) return 0;
  char* end = nullptr;
  const unsigned long long parsed = _strtoui64(value, &end, 10);
  return (end && *end == '\0') ? static_cast<uintptr_t>(parsed) : 0;
}

static bool ParseBoundsCommand(const std::string& line, BoundsCommand* output) {
  if (!output) return false;
  std::istringstream in(line);
  std::string command;
  int visibleInt = 1;
  int holeCount = 0;
  BoundsCommand parsed{};
  if (!(in >> command) || command != "B") return false;
  if (!(in >> parsed.x >> parsed.y >> parsed.w >> parsed.h >> visibleInt >> holeCount)) return false;
  parsed.visible = visibleInt != 0;
  holeCount = std::max(0, std::min(holeCount, 16));
  parsed.holes.reserve(static_cast<size_t>(holeCount));
  for (int i = 0; i < holeCount; ++i) {
    Hole hole{};
    if (!(in >> hole.x >> hole.y >> hole.w >> hole.h)) return false;
    parsed.holes.push_back(hole);
  }
  *output = std::move(parsed);
  return true;
}

static HRGN BuildRegion(int width, int height, const std::vector<Hole>& holes) {
  if (width <= 0 || height <= 0) return nullptr;
  HRGN region = CreateRectRgn(0, 0, width, height);
  if (!region) return nullptr;

  for (const auto& hole : holes) {
    const int left = std::max(0, std::min(width, hole.x));
    const int top = std::max(0, std::min(height, hole.y));
    const int right = std::max(left, std::min(width, hole.x + std::max(0, hole.w)));
    const int bottom = std::max(top, std::min(height, hole.y + std::max(0, hole.h)));
    if (right <= left || bottom <= top) continue;

    HRGN cut = CreateRectRgn(left, top, right, bottom);
    if (!cut) continue;
    CombineRgn(region, region, cut, RGN_DIFF);
    DeleteObject(cut);
  }
  return region;
}

static void ApplyRegion(HWND hwnd, int width, int height, const std::vector<Hole>& holes) {
  if (!IsWindow(hwnd) || width <= 0 || height <= 0) return;
  HRGN region = BuildRegion(width, height, holes);
  if (!region) return;
  if (SetWindowRgn(hwnd, region, TRUE) == 0) DeleteObject(region);
}

static int RunRegionSelfTest() {
  BoundsCommand parsed{};
  if (!ParseBoundsCommand("B 3 4 1920 1080 1 3 20 13 42 42 815 970 290 50 1576 1024 322 42", &parsed)) {
    std::cerr << "SELFTEST FAIL parse" << std::endl;
    return 20;
  }
  if (parsed.x != 3 || parsed.y != 4 || parsed.w != 1920 || parsed.h != 1080 ||
      !parsed.visible || parsed.holes.size() != 3) {
    std::cerr << "SELFTEST FAIL bounds" << std::endl;
    return 21;
  }

  HRGN region = BuildRegion(parsed.w, parsed.h, parsed.holes);
  if (!region) {
    std::cerr << "SELFTEST FAIL region-create" << std::endl;
    return 22;
  }

  RECT box{};
  const int type = GetRgnBox(region, &box);
  const bool boxOk = type == COMPLEXREGION && box.left == 0 && box.top == 0 &&
                     box.right == 1920 && box.bottom == 1080;
  const bool outsideKept = PtInRegion(region, 10, 10) && PtInRegion(region, 100, 100) &&
                           PtInRegion(region, 1500, 900) && PtInRegion(region, 1910, 1070);
  const bool holesRemoved = !PtInRegion(region, 30, 30) &&
                            !PtInRegion(region, 900, 990) &&
                            !PtInRegion(region, 1700, 1040);
  DeleteObject(region);

  if (!boxOk || !outsideKept || !holesRemoved) {
    std::cerr << "SELFTEST FAIL region-membership" << std::endl;
    return 23;
  }

  std::cout << "SELFTEST region ok bounds=1920x1080 holes=3" << std::endl;
  return 0;
}

static void PositionHost(HWND hwnd, int x, int y, int w, int h, bool visible,
                         const std::vector<Hole>& holes) {
  if (!IsWindow(hwnd)) return;

  if (!visible) {
    ShowWindow(hwnd, SW_HIDE);
    return;
  }

  const int width = std::max(1, w);
  const int height = std::max(1, h);
  SetWindowPos(
      hwnd,
      HWND_TOP,
      x,
      y,
      width,
      height,
      SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
  ApplyRegion(hwnd, width, height, holes);
  ShowWindow(hwnd, SW_SHOWNA);
}

static void HandleCommand(HWND hwnd, const std::string& line) {
  std::istringstream in(line);
  std::string command;
  in >> command;

  if (command == "Q") {
    DestroyWindow(hwnd);
    return;
  }

  if (command == "H") {
    ShowWindow(hwnd, SW_HIDE);
    return;
  }

  BoundsCommand bounds{};
  if (!ParseBoundsCommand(line, &bounds)) return;
  PositionHost(hwnd, bounds.x, bounds.y, bounds.w, bounds.h, bounds.visible, bounds.holes);
}

static LRESULT CALLBACK HostWndProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_HOST_COMMAND: {
      auto* line = reinterpret_cast<std::string*>(lParam);
      if (line) {
        HandleCommand(hwnd, *line);
        delete line;
      }
      return 0;
    }
    case WM_NCHITTEST:
      return HTTRANSPARENT;
    case WM_MOUSEACTIVATE:
      return MA_NOACTIVATEANDEAT;
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT: {
      PAINTSTRUCT ps{};
      HDC dc = BeginPaint(hwnd, &ps);
      FillRect(dc, &ps.rcPaint, static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
      EndPaint(hwnd, &ps);
      return 0;
    }
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(hwnd, message, wParam, lParam);
  }
}

int main(int argc, char** argv) {
  if (argc == 2 && std::strcmp(argv[1], "--self-test-region") == 0) return RunRegionSelfTest();
  if (argc < 2) {
    std::cout << "ERR args" << std::endl;
    return 2;
  }

  const uintptr_t parentValue = ParseHandle(argv[1]);
  HWND parent = reinterpret_cast<HWND>(parentValue);
  if (!parent || !IsWindow(parent)) {
    std::cout << "ERR parent" << std::endl;
    return 3;
  }

  const HINSTANCE instance = GetModuleHandleW(nullptr);
  const wchar_t* className = L"LilacAnimeRawMpvHostV11";

  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.style = CS_HREDRAW | CS_VREDRAW | CS_OWNDC;
  wc.lpfnWndProc = HostWndProc;
  wc.hInstance = instance;
  wc.hCursor = LoadCursorW(nullptr, MAKEINTRESOURCEW(32512));
  wc.hbrBackground = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
  wc.lpszClassName = className;

  if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
    std::cout << "ERR register" << std::endl;
    return 4;
  }

  HWND host = CreateWindowExW(
      WS_EX_NOACTIVATE | WS_EX_TRANSPARENT,
      className,
      L"",
      WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
      0,
      0,
      1,
      1,
      parent,
      nullptr,
      instance,
      nullptr);

  if (!host) {
    std::cout << "ERR create" << std::endl;
    return 5;
  }

  SetWindowPos(host, HWND_TOP, 0, 0, 1, 1, SWP_NOACTIVATE | SWP_NOOWNERZORDER);
  ShowWindow(host, SW_HIDE);

  std::cout << "READY host "
            << static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(host))
            << std::endl;
  std::cout.flush();

  std::thread inputThread([host]() {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (!IsWindow(host)) break;
      auto* copy = new std::string(line);
      if (!PostMessageW(host, WM_HOST_COMMAND, 0, reinterpret_cast<LPARAM>(copy))) {
        delete copy;
        break;
      }
      if (line == "Q") break;
    }
    if (IsWindow(host)) PostMessageW(host, WM_CLOSE, 0, 0);
  });
  inputThread.detach();

  MSG msg{};
  while (GetMessageW(&msg, nullptr, 0, 0) > 0) {
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  if (IsWindow(host)) DestroyWindow(host);
  return 0;
}

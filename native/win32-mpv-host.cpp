#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <algorithm>
#include <cstdint>
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

static constexpr UINT WM_HOST_COMMAND = WM_APP + 77;

static uintptr_t ParseHandle(const char* value) {
  if (!value || !*value) return 0;
  char* end = nullptr;
  const unsigned long long parsed = _strtoui64(value, &end, 10);
  return (end && *end == '\0') ? static_cast<uintptr_t>(parsed) : 0;
}

static void ApplyRegion(HWND hwnd, int width, int height, const std::vector<Hole>& holes) {
  if (!IsWindow(hwnd) || width <= 0 || height <= 0) return;

  HRGN region = CreateRectRgn(0, 0, width, height);
  if (!region) return;

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

  if (SetWindowRgn(hwnd, region, TRUE) == 0) {
    DeleteObject(region);
  }
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

  if (command != "B") return;

  int x = 0;
  int y = 0;
  int w = 1;
  int h = 1;
  int visibleInt = 1;
  int holeCount = 0;
  in >> x >> y >> w >> h >> visibleInt >> holeCount;
  holeCount = std::max(0, std::min(holeCount, 16));

  std::vector<Hole> holes;
  holes.reserve(static_cast<size_t>(holeCount));
  for (int i = 0; i < holeCount; ++i) {
    Hole hole{};
    if (!(in >> hole.x >> hole.y >> hole.w >> hole.h)) break;
    holes.push_back(hole);
  }

  PositionHost(hwnd, x, y, w, h, visibleInt != 0, holes);
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
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
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

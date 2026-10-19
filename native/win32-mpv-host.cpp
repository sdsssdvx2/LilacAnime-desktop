#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <cstdint>
#include <iterator>

struct Hole {
  int x{};
  int y{};
  int w{};
  int h{};
};

struct FindWindowData {
  DWORD pid{};
  HWND hwnd{};
};

static BOOL CALLBACK EnumTopLevel(HWND hwnd, LPARAM param) {
  auto* data = reinterpret_cast<FindWindowData*>(param);
  DWORD pid = 0;
  GetWindowThreadProcessId(hwnd, &pid);
  if (pid != data->pid) return TRUE;

  const LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
  if ((style & WS_CHILD) != 0) return TRUE;

  wchar_t className[128] = {};
  GetClassNameW(hwnd, className, static_cast<int>(std::size(className)));
  if (wcscmp(className, L"ConsoleWindowClass") == 0) return TRUE;

  data->hwnd = hwnd;
  return FALSE;
}

static HWND FindWindowForPid(DWORD pid, DWORD timeoutMs = 8000) {
  const ULONGLONG deadline = GetTickCount64() + timeoutMs;
  do {
    FindWindowData data{ pid, nullptr };
    EnumWindows(EnumTopLevel, reinterpret_cast<LPARAM>(&data));
    if (data.hwnd && IsWindow(data.hwnd)) return data.hwnd;
    Sleep(50);
  } while (GetTickCount64() < deadline);
  return nullptr;
}

static uintptr_t ParseHandle(const char* value) {
  if (!value || !*value) return 0;
  char* end = nullptr;
  const unsigned long long parsed = _strtoui64(value, &end, 10);
  return (end && *end == '\0') ? static_cast<uintptr_t>(parsed) : 0;
}

static void ApplyRegion(HWND hwnd, int width, int height, const std::vector<Hole>& holes) {
  if (!IsWindow(hwnd)) return;
  if (width <= 0 || height <= 0) return;

  HRGN region = CreateRectRgn(0, 0, width, height);
  if (!region) return;

  for (const auto& hole : holes) {
    const int left = max(0, min(width, hole.x));
    const int top = max(0, min(height, hole.y));
    const int right = max(left, min(width, hole.x + max(0, hole.w)));
    const int bottom = max(top, min(height, hole.y + max(0, hole.h)));
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

static void ClearRegion(HWND hwnd) {
  if (IsWindow(hwnd)) SetWindowRgn(hwnd, nullptr, TRUE);
}

static bool PositionHostedWindow(HWND hwnd, HWND parent, bool childMode,
                                 int x, int y, int w, int h, bool visible,
                                 const std::vector<Hole>& holes) {
  if (!IsWindow(hwnd) || !IsWindow(parent)) return false;

  int px = x;
  int py = y;
  if (!childMode) {
    POINT origin{ 0, 0 };
    if (!ClientToScreen(parent, &origin)) return false;
    px += origin.x;
    py += origin.y;
  }

  if (!visible) {
    ShowWindow(hwnd, SW_HIDE);
    return true;
  }

  const UINT flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW;
  if (!SetWindowPos(hwnd, HWND_TOP, px, py, max(1, w), max(1, h), flags)) return false;
  ApplyRegion(hwnd, max(1, w), max(1, h), holes);
  ShowWindow(hwnd, SW_SHOWNA);
  return true;
}

static bool AttachAsChild(HWND hwnd, HWND parent) {
  if (!IsWindow(hwnd) || !IsWindow(parent)) return false;

  LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
  style &= ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
  style |= (WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN);
  SetWindowLongPtrW(hwnd, GWL_STYLE, style);

  LONG_PTR exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  exStyle &= ~(WS_EX_APPWINDOW | WS_EX_TOPMOST);
  exStyle |= (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle);

  SetLastError(0);
  HWND previous = SetParent(hwnd, parent);
  const DWORD error = GetLastError();
  if (!previous && error != 0) return false;

  SetWindowPos(hwnd, HWND_TOP, 0, 0, 1, 1,
               SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
  return true;
}

static bool AttachAsOwnedOverlay(HWND hwnd, HWND parent) {
  if (!IsWindow(hwnd) || !IsWindow(parent)) return false;

  SetParent(hwnd, nullptr);

  LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
  style &= ~(WS_CHILD | WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX);
  style |= (WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN);
  SetWindowLongPtrW(hwnd, GWL_STYLE, style);

  LONG_PTR exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
  exStyle &= ~(WS_EX_APPWINDOW | WS_EX_TOPMOST);
  exStyle |= (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE);
  SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle);

  SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, reinterpret_cast<LONG_PTR>(parent));
  SetWindowPos(hwnd, HWND_TOP, 0, 0, 1, 1,
               SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
  return true;
}

int main(int argc, char** argv) {
  if (argc < 3) {
    std::cout << "ERR args" << std::endl;
    return 2;
  }

  const DWORD mpvPid = static_cast<DWORD>(strtoul(argv[1], nullptr, 10));
  const uintptr_t parentValue = ParseHandle(argv[2]);
  HWND parent = reinterpret_cast<HWND>(parentValue);
  if (!mpvPid || !parent || !IsWindow(parent)) {
    std::cout << "ERR parent" << std::endl;
    return 3;
  }

  HWND mpv = FindWindowForPid(mpvPid);
  if (!mpv) {
    std::cout << "ERR mpv-window" << std::endl;
    return 4;
  }

  bool childMode = AttachAsChild(mpv, parent);
  if (!childMode) {
    if (!AttachAsOwnedOverlay(mpv, parent)) {
      std::cout << "ERR attach" << std::endl;
      return 5;
    }
  }

  ClearRegion(mpv);
  ShowWindow(mpv, SW_HIDE);
  std::cout << "READY " << (childMode ? "child" : "overlay") << " "
            << static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(mpv))
            << std::endl;

  std::string line;
  while (std::getline(std::cin, line)) {
    if (!IsWindow(parent) || !IsWindow(mpv)) break;
    std::istringstream in(line);
    std::string command;
    in >> command;

    if (command == "Q") break;

    if (command == "B") {
      int x = 0, y = 0, w = 1, h = 1, visibleInt = 1, holeCount = 0;
      in >> x >> y >> w >> h >> visibleInt >> holeCount;
      holeCount = max(0, min(holeCount, 16));
      std::vector<Hole> holes;
      holes.reserve(static_cast<size_t>(holeCount));
      for (int i = 0; i < holeCount; ++i) {
        Hole hole{};
        if (!(in >> hole.x >> hole.y >> hole.w >> hole.h)) break;
        holes.push_back(hole);
      }
      if (!PositionHostedWindow(mpv, parent, childMode, x, y, w, h, visibleInt != 0, holes)) {
        std::cout << "WARN bounds" << std::endl;
      }
      continue;
    }

    if (command == "H") {
      ShowWindow(mpv, SW_HIDE);
      continue;
    }
  }

  if (IsWindow(mpv)) {
    ClearRegion(mpv);
    ShowWindow(mpv, SW_HIDE);
  }
  return 0;
}

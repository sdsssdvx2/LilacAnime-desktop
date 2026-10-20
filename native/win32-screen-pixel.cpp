#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <cstdlib>
#include <iostream>

int main(int argc, char** argv) {
  if (argc != 3) {
    std::cerr << "ERR args" << std::endl;
    return 2;
  }
  const int x = std::atoi(argv[1]);
  const int y = std::atoi(argv[2]);
  HDC dc = GetDC(nullptr);
  if (!dc) {
    std::cerr << "ERR dc" << std::endl;
    return 3;
  }
  const COLORREF value = GetPixel(dc, x, y);
  ReleaseDC(nullptr, dc);
  if (value == CLR_INVALID) {
    std::cerr << "ERR pixel" << std::endl;
    return 4;
  }
  std::cout << "PIXEL " << static_cast<int>(GetRValue(value)) << ' '
            << static_cast<int>(GetGValue(value)) << ' '
            << static_cast<int>(GetBValue(value)) << std::endl;
  return 0;
}

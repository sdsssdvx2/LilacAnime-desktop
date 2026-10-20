#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>
#include <thread>

static constexpr int kWidth = 640;
static constexpr int kHeight = 360;
static std::atomic<bool> gRunning{true};

static uintptr_t ParseHandle(const char* value) {
  if (!value || !*value) return 0;
  char* end = nullptr;
  const unsigned long long parsed = _strtoui64(value, &end, 10);
  return (end && *end == '\0') ? static_cast<uintptr_t>(parsed) : 0;
}

static LRESULT CALLBACK ProbeWndProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_NCHITTEST:
      return HTTRANSPARENT;
    case WM_MOUSEACTIVATE:
      return MA_NOACTIVATEANDEAT;
    case WM_ERASEBKGND:
      return 1;
    case WM_PAINT: {
      PAINTSTRUCT ps{};
      BeginPaint(hwnd, &ps);
      EndPaint(hwnd, &ps);
      return 0;
    }
    case WM_CLOSE:
      DestroyWindow(hwnd);
      return 0;
    case WM_DESTROY:
      gRunning = false;
      PostQuitMessage(0);
      return 0;
    default:
      return DefWindowProcW(hwnd, message, wParam, lParam);
  }
}

static HRESULT CreateRenderer(HWND hwnd,
                              ID3D11Device** device,
                              ID3D11DeviceContext** context,
                              IDXGISwapChain** swapChain,
                              ID3D11RenderTargetView** renderTarget) {
  DXGI_SWAP_CHAIN_DESC desc{};
  desc.BufferDesc.Width = kWidth;
  desc.BufferDesc.Height = kHeight;
  desc.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
  desc.BufferDesc.RefreshRate.Numerator = 60;
  desc.BufferDesc.RefreshRate.Denominator = 1;
  desc.SampleDesc.Count = 1;
  desc.SampleDesc.Quality = 0;
  desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  desc.BufferCount = 2;
  desc.OutputWindow = hwnd;
  desc.Windowed = TRUE;
  desc.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

  const D3D_FEATURE_LEVEL levels[] = {
      D3D_FEATURE_LEVEL_11_1,
      D3D_FEATURE_LEVEL_11_0,
      D3D_FEATURE_LEVEL_10_1,
      D3D_FEATURE_LEVEL_10_0};
  D3D_FEATURE_LEVEL selected{};
  const D3D_DRIVER_TYPE drivers[] = {D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP};

  HRESULT hr = E_FAIL;
  for (const auto driver : drivers) {
    hr = D3D11CreateDeviceAndSwapChain(
        nullptr,
        driver,
        nullptr,
        D3D11_CREATE_DEVICE_BGRA_SUPPORT,
        levels,
        static_cast<UINT>(sizeof(levels) / sizeof(levels[0])),
        D3D11_SDK_VERSION,
        &desc,
        swapChain,
        device,
        &selected,
        context);
    if (SUCCEEDED(hr)) break;
  }
  if (FAILED(hr)) return hr;

  ID3D11Texture2D* backBuffer = nullptr;
  hr = (*swapChain)->GetBuffer(0, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(&backBuffer));
  if (FAILED(hr)) return hr;
  hr = (*device)->CreateRenderTargetView(backBuffer, nullptr, renderTarget);
  backBuffer->Release();
  return hr;
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
  const wchar_t* className = L"LilacAnimeD3D11LayerProbe";
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.style = CS_HREDRAW | CS_VREDRAW | CS_OWNDC;
  wc.lpfnWndProc = ProbeWndProc;
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
      kWidth,
      kHeight,
      parent,
      nullptr,
      instance,
      nullptr);
  if (!host) {
    std::cout << "ERR create" << std::endl;
    return 5;
  }

  SetWindowPos(host, HWND_TOP, 0, 0, kWidth, kHeight,
               SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
  ShowWindow(host, SW_SHOWNA);

  ID3D11Device* device = nullptr;
  ID3D11DeviceContext* context = nullptr;
  IDXGISwapChain* swapChain = nullptr;
  ID3D11RenderTargetView* renderTarget = nullptr;
  const HRESULT rendererHr = CreateRenderer(host, &device, &context, &swapChain, &renderTarget);
  if (FAILED(rendererHr)) {
    std::cout << "ERR d3d11 " << static_cast<unsigned long>(rendererHr) << std::endl;
    DestroyWindow(host);
    return 6;
  }

  std::cout << "READY host "
            << static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(host))
            << std::endl;
  std::cout.flush();

  std::thread inputThread([host]() {
    std::string line;
    while (std::getline(std::cin, line)) {
      if (line == "Q") {
        if (IsWindow(host)) PostMessageW(host, WM_CLOSE, 0, 0);
        break;
      }
    }
  });
  inputThread.detach();

  const float clearColor[4] = {0.02f, 0.25f, 0.90f, 1.0f};
  auto nextTopRefresh = std::chrono::steady_clock::now();
  MSG msg{};
  while (gRunning && IsWindow(host)) {
    while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
      if (msg.message == WM_QUIT) {
        gRunning = false;
        break;
      }
      TranslateMessage(&msg);
      DispatchMessageW(&msg);
    }
    if (!gRunning || !IsWindow(host)) break;

    const auto now = std::chrono::steady_clock::now();
    if (now >= nextTopRefresh) {
      SetWindowPos(host, HWND_TOP, 0, 0, kWidth, kHeight,
                   SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
      nextTopRefresh = now + std::chrono::milliseconds(100);
    }

    context->OMSetRenderTargets(1, &renderTarget, nullptr);
    context->ClearRenderTargetView(renderTarget, clearColor);
    const HRESULT presentHr = swapChain->Present(1, 0);
    if (FAILED(presentHr)) {
      std::cout << "ERR present " << static_cast<unsigned long>(presentHr) << std::endl;
      break;
    }
    Sleep(16);
  }

  if (renderTarget) renderTarget->Release();
  if (swapChain) swapChain->Release();
  if (context) context->Release();
  if (device) device->Release();
  if (IsWindow(host)) DestroyWindow(host);
  return 0;
}

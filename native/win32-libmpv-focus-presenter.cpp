#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <d3d11.h>
#include <dxgi.h>
#include <wrl/client.h>

#include <atomic>
#include <cstdint>
#include <cstdlib>
#include <iostream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <unordered_map>

using Microsoft::WRL::ComPtr;

namespace {

struct CachedTexture {
  uint64_t sourceHandle = 0;
  UINT width = 0;
  UINT height = 0;
  ComPtr<ID3D11Texture2D> texture;
};

HWND gParent = nullptr;
HWND gHost = nullptr;
HANDLE gSourceProcess = nullptr;
std::atomic<bool> gRunning{true};
std::mutex gRenderMutex;

int gX = 0;
int gY = 0;
int gWidth = 2;
int gHeight = 2;
bool gVisibleWanted = false;
bool gHaveFrame = false;

ComPtr<ID3D11Device> gDevice;
ComPtr<ID3D11Device1> gDevice1;
ComPtr<ID3D11DeviceContext> gContext;
ComPtr<IDXGISwapChain> gSwapChain;
ComPtr<ID3D11Texture2D> gBackBuffer;
UINT gBackWidth = 0;
UINT gBackHeight = 0;
std::unordered_map<uint32_t, CachedTexture> gTextures;

uint64_t ParseU64(const std::string& value) {
  char* end = nullptr;
  const unsigned long long parsed = _strtoui64(value.c_str(), &end, 10);
  return end && *end == '\0' ? static_cast<uint64_t>(parsed) : 0;
}

uintptr_t ParseHandle(const char* value) {
  if (!value || !*value) return 0;
  char* end = nullptr;
  const unsigned long long parsed = _strtoui64(value, &end, 10);
  return end && *end == '\0' ? static_cast<uintptr_t>(parsed) : 0;
}

LRESULT CALLBACK PresenterWndProc(HWND hwnd, UINT message, WPARAM wParam, LPARAM lParam) {
  switch (message) {
    case WM_NCHITTEST: return HTTRANSPARENT;
    case WM_MOUSEACTIVATE: return MA_NOACTIVATE;
    case WM_ERASEBKGND: return 1;
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

void ApplyBounds() {
  if (!gHost || !IsWindow(gHost)) return;
  SetWindowPos(gHost, HWND_TOP, gX, gY, gWidth, gHeight,
               SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_FRAMECHANGED |
                 (gVisibleWanted && gHaveFrame ? SWP_SHOWWINDOW : SWP_NOREDRAW));
  if (!gVisibleWanted || !gHaveFrame) ShowWindow(gHost, SW_HIDE);
}

void SetVisibleWanted(bool visible) {
  gVisibleWanted = visible;
  if (!gHost || !IsWindow(gHost)) return;
  if (visible && gHaveFrame) {
    SetWindowPos(gHost, HWND_TOP, gX, gY, gWidth, gHeight,
                 SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    ShowWindow(gHost, SW_SHOWNOACTIVATE);
  } else if (!visible) {
    ShowWindow(gHost, SW_HIDE);
  }
}

void ResetRenderer() {
  gTextures.clear();
  gBackBuffer.Reset();
  gSwapChain.Reset();
  gContext.Reset();
  gDevice1.Reset();
  gDevice.Reset();
  gBackWidth = gBackHeight = 0;
  gHaveFrame = false;
}

HRESULT EnsureDevice() {
  if (gDevice && gContext && gDevice1) return S_OK;
  const D3D_FEATURE_LEVEL levels[] = {
    D3D_FEATURE_LEVEL_11_1,
    D3D_FEATURE_LEVEL_11_0,
    D3D_FEATURE_LEVEL_10_1,
    D3D_FEATURE_LEVEL_10_0
  };
  D3D_FEATURE_LEVEL selected{};
  HRESULT hr = D3D11CreateDevice(
    nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr,
    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
    levels, static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION,
    &gDevice, &selected, &gContext);
  if (FAILED(hr)) {
    hr = D3D11CreateDevice(
      nullptr, D3D_DRIVER_TYPE_WARP, nullptr,
      D3D11_CREATE_DEVICE_BGRA_SUPPORT,
      levels, static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION,
      &gDevice, &selected, &gContext);
  }
  if (FAILED(hr)) return hr;
  return gDevice.As(&gDevice1);
}

HRESULT EnsureSwapChain(UINT width, UINT height) {
  if (gSwapChain && gBackBuffer && gBackWidth == width && gBackHeight == height) return S_OK;
  gBackBuffer.Reset();
  gSwapChain.Reset();
  gBackWidth = gBackHeight = 0;
  HRESULT hr = EnsureDevice();
  if (FAILED(hr)) return hr;

  ComPtr<IDXGIDevice> dxgiDevice;
  ComPtr<IDXGIAdapter> adapter;
  ComPtr<IDXGIFactory> factory;
  if (FAILED(hr = gDevice.As(&dxgiDevice))) return hr;
  if (FAILED(hr = dxgiDevice->GetAdapter(&adapter))) return hr;
  if (FAILED(hr = adapter->GetParent(__uuidof(IDXGIFactory), reinterpret_cast<void**>(factory.GetAddressOf())))) return hr;

  DXGI_SWAP_CHAIN_DESC desc{};
  desc.BufferDesc.Width = width;
  desc.BufferDesc.Height = height;
  desc.BufferDesc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
  desc.BufferCount = 2;
  desc.OutputWindow = gHost;
  desc.Windowed = TRUE;
  desc.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;
  hr = factory->CreateSwapChain(gDevice.Get(), &desc, &gSwapChain);
  if (FAILED(hr)) return hr;
  hr = gSwapChain->GetBuffer(0, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(gBackBuffer.GetAddressOf()));
  if (SUCCEEDED(hr)) {
    gBackWidth = width;
    gBackHeight = height;
  }
  return hr;
}

HRESULT OpenTexture(uint32_t slotId, uint64_t sourceHandle, UINT width, UINT height, ID3D11Texture2D** out) {
  if (!out || !sourceHandle) return E_INVALIDARG;
  *out = nullptr;
  HRESULT hr = EnsureDevice();
  if (FAILED(hr)) return hr;

  auto it = gTextures.find(slotId);
  if (it != gTextures.end() && it->second.sourceHandle == sourceHandle &&
      it->second.width == width && it->second.height == height && it->second.texture) {
    *out = it->second.texture.Get();
    (*out)->AddRef();
    return S_OK;
  }

  HANDLE localHandle = nullptr;
  const HANDLE remoteHandle = reinterpret_cast<HANDLE>(static_cast<uintptr_t>(sourceHandle));
  if (!DuplicateHandle(gSourceProcess, remoteHandle, GetCurrentProcess(), &localHandle,
                       0, FALSE, DUPLICATE_SAME_ACCESS)) {
    return HRESULT_FROM_WIN32(GetLastError());
  }

  ComPtr<ID3D11Texture2D> texture;
  hr = gDevice1->OpenSharedResource1(localHandle, __uuidof(ID3D11Texture2D), reinterpret_cast<void**>(texture.GetAddressOf()));
  CloseHandle(localHandle);
  if (FAILED(hr)) return hr;

  D3D11_TEXTURE2D_DESC desc{};
  texture->GetDesc(&desc);
  if (desc.Width != width || desc.Height != height || desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM) {
    return E_INVALIDARG;
  }

  CachedTexture cached{};
  cached.sourceHandle = sourceHandle;
  cached.width = width;
  cached.height = height;
  cached.texture = texture;
  gTextures[slotId] = cached;
  *out = texture.Detach();
  return S_OK;
}

HRESULT PresentFrame(uint32_t slotId, uint64_t frameId, uint64_t sourceHandle, UINT width, UINT height) {
  std::lock_guard<std::mutex> lock(gRenderMutex);
  if (!gHost || !IsWindow(gHost)) return E_FAIL;
  HRESULT hr = EnsureSwapChain(width, height);
  if (FAILED(hr)) return hr;

  ComPtr<ID3D11Texture2D> source;
  hr = OpenTexture(slotId, sourceHandle, width, height, &source);
  if (FAILED(hr)) return hr;

  gContext->CopyResource(gBackBuffer.Get(), source.Get());
  gContext->Flush();
  if (gVisibleWanted) {
    SetWindowPos(gHost, HWND_TOP, gX, gY, gWidth, gHeight,
                 SWP_NOACTIVATE | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    ShowWindow(gHost, SW_SHOWNOACTIVATE);
  }
  hr = gSwapChain->Present(1, 0);
  if (hr == DXGI_STATUS_OCCLUDED) hr = S_OK;
  if (SUCCEEDED(hr)) gHaveFrame = true;
  return hr;
}

void InputLoop() {
  std::string line;
  while (gRunning && std::getline(std::cin, line)) {
    std::istringstream in(line);
    std::string command;
    in >> command;
    if (command == "Q") {
      if (gHost && IsWindow(gHost)) PostMessageW(gHost, WM_CLOSE, 0, 0);
      break;
    }
    if (command == "B") {
      int x = 0, y = 0, width = 2, height = 2;
      if (in >> x >> y >> width >> height) {
        gX = x;
        gY = y;
        gWidth = max(2, width);
        gHeight = max(2, height);
        ApplyBounds();
      }
      continue;
    }
    if (command == "V") {
      int visible = 0;
      if (in >> visible) SetVisibleWanted(visible != 0);
      continue;
    }
    if (command == "F") {
      uint32_t slotId = 0;
      uint64_t frameId = 0;
      std::string handleText;
      UINT width = 0, height = 0;
      if (!(in >> slotId >> frameId >> handleText >> width >> height)) continue;
      const uint64_t sourceHandle = ParseU64(handleText);
      const HRESULT hr = PresentFrame(slotId, frameId, sourceHandle, width, height);
      if (SUCCEEDED(hr)) {
        std::cout << "P " << slotId << ' ' << frameId << std::endl;
      } else {
        std::cout << "E " << slotId << ' ' << frameId << ' ' << static_cast<unsigned long>(hr) << std::endl;
      }
      std::cout.flush();
      continue;
    }
  }
}

}  // namespace

int main(int argc, char** argv) {
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  if (argc < 3) {
    std::cout << "ERR args" << std::endl;
    return 2;
  }

  gParent = reinterpret_cast<HWND>(ParseHandle(argv[1]));
  const DWORD sourcePid = static_cast<DWORD>(strtoul(argv[2], nullptr, 10));
  if (!gParent || !IsWindow(gParent) || !sourcePid) {
    std::cout << "ERR parent" << std::endl;
    return 3;
  }
  gSourceProcess = OpenProcess(PROCESS_DUP_HANDLE, FALSE, sourcePid);
  if (!gSourceProcess) {
    std::cout << "ERR source-process " << GetLastError() << std::endl;
    return 4;
  }

  const HINSTANCE instance = GetModuleHandleW(nullptr);
  const wchar_t* className = L"LilacAnimeLibmpvFocusPresenter";
  WNDCLASSEXW wc{};
  wc.cbSize = sizeof(wc);
  wc.style = CS_HREDRAW | CS_VREDRAW | CS_OWNDC;
  wc.lpfnWndProc = PresenterWndProc;
  wc.hInstance = instance;
  wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
  wc.hbrBackground = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
  wc.lpszClassName = className;
  if (!RegisterClassExW(&wc) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
    std::cout << "ERR register " << GetLastError() << std::endl;
    CloseHandle(gSourceProcess);
    return 5;
  }

  gHost = CreateWindowExW(
    WS_EX_NOACTIVATE | WS_EX_TRANSPARENT | WS_EX_NOPARENTNOTIFY,
    className, L"", WS_CHILD | WS_CLIPSIBLINGS | WS_CLIPCHILDREN,
    0, 0, 2, 2, gParent, nullptr, instance, nullptr);
  if (!gHost) {
    std::cout << "ERR create " << GetLastError() << std::endl;
    CloseHandle(gSourceProcess);
    return 6;
  }
  ShowWindow(gHost, SW_HIDE);

  std::thread input(InputLoop);
  std::cout << "READY " << static_cast<unsigned long long>(reinterpret_cast<uintptr_t>(gHost)) << std::endl;
  std::cout.flush();

  MSG msg{};
  while (gRunning && IsWindow(gHost)) {
    const BOOL got = GetMessageW(&msg, nullptr, 0, 0);
    if (got <= 0) break;
    TranslateMessage(&msg);
    DispatchMessageW(&msg);
  }

  gRunning = false;
  if (input.joinable()) {
    CancelSynchronousIo(input.native_handle());
    input.join();
  }
  ResetRenderer();
  if (gSourceProcess) CloseHandle(gSourceProcess);
  gSourceProcess = nullptr;
  if (gHost && IsWindow(gHost)) DestroyWindow(gHost);
  return 0;
}

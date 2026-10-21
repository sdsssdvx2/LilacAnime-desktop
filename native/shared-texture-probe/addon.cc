#include <node_api.h>
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

using Microsoft::WRL::ComPtr;

namespace {

struct DeviceState {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  D3D_FEATURE_LEVEL featureLevel = D3D_FEATURE_LEVEL_9_1;
  const char* deviceMode = "unknown";
};

struct TextureResource {
  ComPtr<ID3D11Texture2D> texture;
  HANDLE sharedHandle = nullptr;
  uint32_t width = 0;
  uint32_t height = 0;
};

std::mutex gMutex;
DeviceState gDevice;
bool gDeviceReady = false;
std::unordered_map<uint32_t, std::unique_ptr<TextureResource>> gResources;
uint32_t gNextId = 1;

void Throw(napi_env env, const char* message) {
  napi_throw_error(env, nullptr, message);
}

std::string HrHex(HRESULT hr) {
  char buffer[16]{};
  std::snprintf(buffer, sizeof(buffer), "0x%08X", static_cast<unsigned int>(hr));
  return std::string(buffer);
}

std::string FeatureLevelText(D3D_FEATURE_LEVEL level) {
  char buffer[16]{};
  std::snprintf(buffer, sizeof(buffer), "0x%04X", static_cast<unsigned int>(level));
  return std::string(buffer);
}

bool GetUint32(napi_env env, napi_value value, uint32_t* out) {
  return napi_get_value_uint32(env, value, out) == napi_ok;
}

napi_value MakeBool(napi_env env, bool value) {
  napi_value out;
  napi_get_boolean(env, value, &out);
  return out;
}

bool EnsureDevice(std::string* error) {
  std::lock_guard<std::mutex> lock(gMutex);
  if (gDeviceReady && gDevice.device && gDevice.context) return true;

  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  D3D_FEATURE_LEVEL levels[] = {
    D3D_FEATURE_LEVEL_11_1,
    D3D_FEATURE_LEVEL_11_0,
    D3D_FEATURE_LEVEL_10_1,
    D3D_FEATURE_LEVEL_10_0
  };
  D3D_FEATURE_LEVEL actual{};
  HRESULT hardwareHr = D3D11CreateDevice(
    nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
    levels, static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION,
    &gDevice.device, &actual, &gDevice.context);
  HRESULT warpHr = S_OK;
  HRESULT hr = hardwareHr;
  if (SUCCEEDED(hardwareHr)) {
    gDevice.deviceMode = "hardware";
  } else {
    gDevice.device.Reset();
    gDevice.context.Reset();
    warpHr = D3D11CreateDevice(
      nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags,
      levels, static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION,
      &gDevice.device, &actual, &gDevice.context);
    hr = warpHr;
    if (SUCCEEDED(warpHr)) gDevice.deviceMode = "warp";
  }
  if (FAILED(hr)) {
    if (error) {
      *error = "D3D11_DEVICE_FAILED hr=" + HrHex(hr) +
        " hardwareHr=" + HrHex(hardwareHr) + " warpHr=" + HrHex(warpHr);
    }
    return false;
  }
  gDevice.featureLevel = actual;
  gDeviceReady = true;
  return true;
}

bool FillTexture(TextureResource* resource, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
  if (!resource || !resource->texture || !gDevice.context) return false;
  const size_t rowBytes = static_cast<size_t>(resource->width) * 4;
  std::vector<uint8_t> pixels(rowBytes * resource->height);
  for (size_t i = 0; i < pixels.size(); i += 4) {
    pixels[i + 0] = b;
    pixels[i + 1] = g;
    pixels[i + 2] = r;
    pixels[i + 3] = a;
  }
  gDevice.context->UpdateSubresource(resource->texture.Get(), 0, nullptr, pixels.data(), static_cast<UINT>(rowBytes), 0);
  gDevice.context->Flush();
  return true;
}

std::unique_ptr<TextureResource> CreateTexture(uint32_t width, uint32_t height, uint8_t r, uint8_t g, uint8_t b, uint8_t a, std::string* error) {
  if (!EnsureDevice(error)) return nullptr;
  auto resource = std::make_unique<TextureResource>();
  resource->width = width;
  resource->height = height;

  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = width;
  desc.Height = height;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  desc.CPUAccessFlags = 0;
  // Match Electron/Chromium's Windows BGRA shared-texture contract: NT handle, no keyed mutex.
  desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE;

  HRESULT hr = gDevice.device->CreateTexture2D(&desc, nullptr, &resource->texture);
  if (FAILED(hr)) {
    if (error) *error = "D3D11_TEXTURE_FAILED hr=" + HrHex(hr);
    return nullptr;
  }

  ComPtr<IDXGIResource1> dxgiResource;
  hr = resource->texture.As(&dxgiResource);
  if (FAILED(hr)) {
    if (error) *error = "DXGI_RESOURCE_FAILED hr=" + HrHex(hr);
    return nullptr;
  }
  hr = dxgiResource->CreateSharedHandle(nullptr,
    DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
    nullptr, &resource->sharedHandle);
  if (FAILED(hr) || !resource->sharedHandle) {
    if (error) *error = "SHARED_HANDLE_FAILED hr=" + HrHex(FAILED(hr) ? hr : E_HANDLE);
    return nullptr;
  }
  if (!FillTexture(resource.get(), r, g, b, a)) {
    if (error) *error = "FILL_TEXTURE_FAILED";
    return nullptr;
  }
  return resource;
}

napi_value PixelObject(napi_env env, uint8_t r, uint8_t g, uint8_t b, uint8_t a) {
  napi_value out, vr, vg, vb, va;
  napi_create_object(env, &out);
  napi_create_uint32(env, r, &vr);
  napi_create_uint32(env, g, &vg);
  napi_create_uint32(env, b, &vb);
  napi_create_uint32(env, a, &va);
  napi_set_named_property(env, out, "r", vr);
  napi_set_named_property(env, out, "g", vg);
  napi_set_named_property(env, out, "b", vb);
  napi_set_named_property(env, out, "a", va);
  return out;
}

napi_value CreateSolidTexture(napi_env env, napi_callback_info info) {
  size_t argc = 6;
  napi_value argv[6];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 5) {
    Throw(env, "createSolidTexture(width,height,r,g,b[,a]) requires at least 5 arguments");
    return nullptr;
  }
  uint32_t width = 0, height = 0, r = 0, g = 0, b = 0, a = 255;
  if (!GetUint32(env, argv[0], &width) || !GetUint32(env, argv[1], &height) ||
      !GetUint32(env, argv[2], &r) || !GetUint32(env, argv[3], &g) || !GetUint32(env, argv[4], &b) ||
      (argc >= 6 && !GetUint32(env, argv[5], &a))) {
    Throw(env, "createSolidTexture arguments must be unsigned integers");
    return nullptr;
  }
  if (!width || !height || width > 4096 || height > 4096) {
    Throw(env, "invalid texture size");
    return nullptr;
  }

  std::string error;
  auto resource = CreateTexture(width, height,
    static_cast<uint8_t>(std::min<uint32_t>(r, 255)),
    static_cast<uint8_t>(std::min<uint32_t>(g, 255)),
    static_cast<uint8_t>(std::min<uint32_t>(b, 255)),
    static_cast<uint8_t>(std::min<uint32_t>(a, 255)), &error);
  if (!resource) {
    Throw(env, error.c_str());
    return nullptr;
  }

  uint32_t id;
  HANDLE handle = resource->sharedHandle;
  {
    std::lock_guard<std::mutex> lock(gMutex);
    id = gNextId++;
    gResources.emplace(id, std::move(resource));
  }

  napi_value out, idValue, widthValue, heightValue, formatValue, handleBuffer, modeValue, featureValue;
  napi_create_object(env, &out);
  napi_create_uint32(env, id, &idValue);
  napi_create_uint32(env, width, &widthValue);
  napi_create_uint32(env, height, &heightValue);
  napi_create_string_utf8(env, "bgra", NAPI_AUTO_LENGTH, &formatValue);
  napi_create_string_utf8(env, gDevice.deviceMode, NAPI_AUTO_LENGTH, &modeValue);
  const std::string feature = FeatureLevelText(gDevice.featureLevel);
  napi_create_string_utf8(env, feature.c_str(), NAPI_AUTO_LENGTH, &featureValue);
  void* copied = nullptr;
  napi_create_buffer_copy(env, sizeof(HANDLE), &handle, &copied, &handleBuffer);
  napi_set_named_property(env, out, "id", idValue);
  napi_set_named_property(env, out, "width", widthValue);
  napi_set_named_property(env, out, "height", heightValue);
  napi_set_named_property(env, out, "pixelFormat", formatValue);
  napi_set_named_property(env, out, "ntHandle", handleBuffer);
  napi_set_named_property(env, out, "deviceMode", modeValue);
  napi_set_named_property(env, out, "featureLevel", featureValue);
  return out;
}

napi_value SampleTexture(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  if (argc < 1 || !GetUint32(env, argv[0], &id)) {
    Throw(env, "sampleTexture(id) requires texture id");
    return nullptr;
  }
  TextureResource* resource = nullptr;
  {
    std::lock_guard<std::mutex> lock(gMutex);
    auto it = gResources.find(id);
    if (it != gResources.end()) resource = it->second.get();
  }
  if (!resource || !resource->texture) {
    Throw(env, "texture not found");
    return nullptr;
  }

  D3D11_TEXTURE2D_DESC sourceDesc{};
  resource->texture->GetDesc(&sourceDesc);
  D3D11_TEXTURE2D_DESC stagingDesc = sourceDesc;
  stagingDesc.Usage = D3D11_USAGE_STAGING;
  stagingDesc.BindFlags = 0;
  stagingDesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  stagingDesc.MiscFlags = 0;
  ComPtr<ID3D11Texture2D> staging;
  HRESULT hr = gDevice.device->CreateTexture2D(&stagingDesc, nullptr, &staging);
  if (FAILED(hr)) {
    Throw(env, ("staging texture failed " + HrHex(hr)).c_str());
    return nullptr;
  }
  gDevice.context->CopyResource(staging.Get(), resource->texture.Get());
  gDevice.context->Flush();
  D3D11_MAPPED_SUBRESOURCE mapped{};
  hr = gDevice.context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped);
  if (FAILED(hr) || !mapped.pData) {
    Throw(env, ("map staging failed " + HrHex(hr)).c_str());
    return nullptr;
  }
  const auto* p = static_cast<const uint8_t*>(mapped.pData);
  const uint8_t b = p[0], g = p[1], r = p[2], a = p[3];
  gDevice.context->Unmap(staging.Get(), 0);
  return PixelObject(env, r, g, b, a);
}

napi_value ReleaseTexture(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  if (argc < 1 || !GetUint32(env, argv[0], &id)) return MakeBool(env, false);
  std::unique_ptr<TextureResource> resource;
  {
    std::lock_guard<std::mutex> lock(gMutex);
    auto it = gResources.find(id);
    if (it == gResources.end()) return MakeBool(env, false);
    resource = std::move(it->second);
    gResources.erase(it);
  }
  if (resource && resource->sharedHandle) {
    CloseHandle(resource->sharedHandle);
    resource->sharedHandle = nullptr;
  }
  return MakeBool(env, true);
}

napi_value OsClick(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t x = 0, y = 0;
  if (argc < 2 || !GetUint32(env, argv[0], &x) || !GetUint32(env, argv[1], &y)) return MakeBool(env, false);
  POINT previous{};
  GetCursorPos(&previous);
  if (!SetCursorPos(static_cast<int>(x), static_cast<int>(y))) return MakeBool(env, false);
  Sleep(60);
  INPUT inputs[2]{};
  inputs[0].type = INPUT_MOUSE;
  inputs[0].mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
  inputs[1].type = INPUT_MOUSE;
  inputs[1].mi.dwFlags = MOUSEEVENTF_LEFTUP;
  const UINT sent = SendInput(2, inputs, sizeof(INPUT));
  Sleep(80);
  SetCursorPos(previous.x, previous.y);
  return MakeBool(env, sent == 2);
}

void Cleanup(void*) {
  std::lock_guard<std::mutex> lock(gMutex);
  for (auto& [id, resource] : gResources) {
    if (resource && resource->sharedHandle) CloseHandle(resource->sharedHandle);
  }
  gResources.clear();
  gDevice.context.Reset();
  gDevice.device.Reset();
  gDeviceReady = false;
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"createSolidTexture", nullptr, CreateSolidTexture, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sampleTexture", nullptr, SampleTexture, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"releaseTexture", nullptr, ReleaseTexture, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"osClick", nullptr, OsClick, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, std::size(props), props);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

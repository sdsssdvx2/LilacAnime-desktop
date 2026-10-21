#include <node_api.h>
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_d3d11.h>

#include <chrono>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <string>
#include <thread>

using Microsoft::WRL::ComPtr;

namespace {

struct MpvApi {
  HMODULE module = nullptr;
  decltype(&mpv_create) create = nullptr;
  decltype(&mpv_set_option_string) set_option_string = nullptr;
  decltype(&mpv_initialize) initialize = nullptr;
  decltype(&mpv_command) command = nullptr;
  decltype(&mpv_wait_event) wait_event = nullptr;
  decltype(&mpv_terminate_destroy) terminate_destroy = nullptr;
  decltype(&mpv_error_string) error_string = nullptr;
  decltype(&mpv_client_api_version) client_api_version = nullptr;
  decltype(&mpv_render_context_create) render_context_create = nullptr;
  decltype(&mpv_render_context_update) render_context_update = nullptr;
  decltype(&mpv_render_context_render) render_context_render = nullptr;
  decltype(&mpv_render_context_free) render_context_free = nullptr;
};

MpvApi gMpv;

std::string HrHex(HRESULT hr) {
  char buf[16]{};
  std::snprintf(buf, sizeof(buf), "0x%08X", static_cast<unsigned int>(hr));
  return std::string(buf);
}

std::string FeatureLevelText(D3D_FEATURE_LEVEL level) {
  char buf[16]{};
  std::snprintf(buf, sizeof(buf), "0x%04X", static_cast<unsigned int>(level));
  return std::string(buf);
}

void Throw(napi_env env, const std::string& message) {
  napi_throw_error(env, nullptr, message.c_str());
}

bool ReadUtf8(napi_env env, napi_value value, std::string* out) {
  size_t len = 0;
  if (napi_get_value_string_utf8(env, value, nullptr, 0, &len) != napi_ok) return false;
  std::string text(len, '\0');
  size_t written = 0;
  if (napi_get_value_string_utf8(env, value, text.data(), len + 1, &written) != napi_ok) return false;
  text.resize(written);
  *out = std::move(text);
  return true;
}

napi_value MakeString(napi_env env, const std::string& value) {
  napi_value out;
  napi_create_string_utf8(env, value.c_str(), value.size(), &out);
  return out;
}

napi_value MakeBool(napi_env env, bool value) {
  napi_value out;
  napi_get_boolean(env, value, &out);
  return out;
}

napi_value MakeUint32(napi_env env, uint32_t value) {
  napi_value out;
  napi_create_uint32(env, value, &out);
  return out;
}

napi_value MakeDouble(napi_env env, double value) {
  napi_value out;
  napi_create_double(env, value, &out);
  return out;
}

template <typename T>
bool LoadProc(HMODULE module, const char* name, T* out) {
  *out = reinterpret_cast<T>(GetProcAddress(module, name));
  return *out != nullptr;
}

bool LoadMpv(std::string* error) {
  if (gMpv.module) return true;

  char explicitPath[32768]{};
  DWORD n = GetEnvironmentVariableA("LILAC_LIBMPV_DLL", explicitPath, static_cast<DWORD>(sizeof(explicitPath)));
  HMODULE module = nullptr;
  if (n > 0 && n < sizeof(explicitPath)) module = LoadLibraryA(explicitPath);
  if (!module) module = LoadLibraryA("libmpv-2.dll");
  if (!module) module = LoadLibraryA("mpv-2.dll");
  if (!module) {
    *error = "LOAD_LIBMPV_FAILED win32=" + std::to_string(GetLastError());
    return false;
  }

#define LOAD_MPV(name, field) \
  if (!LoadProc(module, name, &gMpv.field)) { \
    *error = std::string("MISSING_LIBMPV_SYMBOL ") + name; \
    FreeLibrary(module); \
    gMpv = {}; \
    return false; \
  }

  LOAD_MPV("mpv_create", create);
  LOAD_MPV("mpv_set_option_string", set_option_string);
  LOAD_MPV("mpv_initialize", initialize);
  LOAD_MPV("mpv_command", command);
  LOAD_MPV("mpv_wait_event", wait_event);
  LOAD_MPV("mpv_terminate_destroy", terminate_destroy);
  LOAD_MPV("mpv_error_string", error_string);
  LOAD_MPV("mpv_client_api_version", client_api_version);
  LOAD_MPV("mpv_render_context_create", render_context_create);
  LOAD_MPV("mpv_render_context_update", render_context_update);
  LOAD_MPV("mpv_render_context_render", render_context_render);
  LOAD_MPV("mpv_render_context_free", render_context_free);
#undef LOAD_MPV

  gMpv.module = module;
  return true;
}

std::string MpvError(int code) {
  if (code >= 0) return "ok";
  if (gMpv.error_string) {
    const char* text = gMpv.error_string(code);
    if (text) return text;
  }
  return "mpv error " + std::to_string(code);
}

struct D3DState {
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  ComPtr<ID3D11Texture2D> target;
  HANDLE sharedHandle = nullptr;
  D3D_FEATURE_LEVEL featureLevel = D3D_FEATURE_LEVEL_9_1;
  const char* deviceMode = "none";
  uint32_t width = 0;
  uint32_t height = 0;

  ~D3DState() {
    if (sharedHandle) CloseHandle(sharedHandle);
  }
};

bool InitD3D(D3DState* state, uint32_t width, uint32_t height, std::string* error) {
  UINT flags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
  D3D_FEATURE_LEVEL levels[] = {
    D3D_FEATURE_LEVEL_11_1,
    D3D_FEATURE_LEVEL_11_0,
    D3D_FEATURE_LEVEL_10_1,
    D3D_FEATURE_LEVEL_10_0
  };
  D3D_FEATURE_LEVEL actual{};
  HRESULT hr = D3D11CreateDevice(
    nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, flags,
    levels, static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION,
    &state->device, &actual, &state->context);
  if (SUCCEEDED(hr)) {
    state->deviceMode = "hardware";
  } else {
    state->device.Reset();
    state->context.Reset();
    hr = D3D11CreateDevice(
      nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags,
      levels, static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION,
      &state->device, &actual, &state->context);
    if (FAILED(hr)) {
      *error = "D3D11CreateDevice failed " + HrHex(hr);
      return false;
    }
    state->deviceMode = "warp";
  }
  state->featureLevel = actual;
  state->width = width;
  state->height = height;

  D3D11_TEXTURE2D_DESC desc{};
  desc.Width = width;
  desc.Height = height;
  desc.MipLevels = 1;
  desc.ArraySize = 1;
  desc.Format = DXGI_FORMAT_B8G8R8A8_UNORM;
  desc.SampleDesc.Count = 1;
  desc.Usage = D3D11_USAGE_DEFAULT;
  desc.BindFlags = D3D11_BIND_RENDER_TARGET | D3D11_BIND_SHADER_RESOURCE;
  desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED_NTHANDLE | D3D11_RESOURCE_MISC_SHARED;

  hr = state->device->CreateTexture2D(&desc, nullptr, &state->target);
  if (FAILED(hr)) {
    *error = "CreateTexture2D failed " + HrHex(hr);
    return false;
  }

  ComPtr<IDXGIResource1> dxgi;
  hr = state->target.As(&dxgi);
  if (FAILED(hr)) {
    *error = "Query IDXGIResource1 failed " + HrHex(hr);
    return false;
  }
  hr = dxgi->CreateSharedHandle(
    nullptr,
    DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
    nullptr,
    &state->sharedHandle);
  if (FAILED(hr) || !state->sharedHandle) {
    *error = "CreateSharedHandle failed " + HrHex(hr);
    return false;
  }
  return true;
}

bool SampleCenter(D3DState* state, uint8_t* r, uint8_t* g, uint8_t* b, uint8_t* a, std::string* error) {
  D3D11_TEXTURE2D_DESC desc{};
  state->target->GetDesc(&desc);
  desc.Usage = D3D11_USAGE_STAGING;
  desc.BindFlags = 0;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  desc.MiscFlags = 0;
  ComPtr<ID3D11Texture2D> staging;
  HRESULT hr = state->device->CreateTexture2D(&desc, nullptr, &staging);
  if (FAILED(hr)) {
    *error = "Create staging texture failed " + HrHex(hr);
    return false;
  }
  state->context->CopyResource(staging.Get(), state->target.Get());
  D3D11_MAPPED_SUBRESOURCE mapped{};
  hr = state->context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped);
  if (FAILED(hr)) {
    *error = "Map staging texture failed " + HrHex(hr);
    return false;
  }
  const uint32_t x = state->width / 2;
  const uint32_t y = state->height / 2;
  const uint8_t* p = static_cast<const uint8_t*>(mapped.pData) + static_cast<size_t>(y) * mapped.RowPitch + static_cast<size_t>(x) * 4;
  *b = p[0];
  *g = p[1];
  *r = p[2];
  *a = p[3];
  state->context->Unmap(staging.Get(), 0);
  return true;
}

napi_value SmokeRender(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  if (argc < 1) {
    Throw(env, "smokeRender(path) requires a media path");
    return nullptr;
  }
  std::string mediaPath;
  if (!ReadUtf8(env, argv[0], &mediaPath)) {
    Throw(env, "media path must be a string");
    return nullptr;
  }

  std::string error;
  if (!LoadMpv(&error)) {
    Throw(env, error);
    return nullptr;
  }

  D3DState d3d;
  if (!InitD3D(&d3d, 256, 144, &error)) {
    Throw(env, error);
    return nullptr;
  }

  mpv_handle* handle = gMpv.create();
  if (!handle) {
    Throw(env, "mpv_create failed");
    return nullptr;
  }
  mpv_render_context* render = nullptr;
  auto cleanup = [&]() {
    if (render) {
      gMpv.render_context_free(render);
      render = nullptr;
    }
    if (handle) {
      gMpv.terminate_destroy(handle);
      handle = nullptr;
    }
  };

  auto setOption = [&](const char* key, const char* value) -> bool {
    int rc = gMpv.set_option_string(handle, key, value);
    if (rc < 0) {
      error = std::string("mpv_set_option_string(") + key + ") failed: " + MpvError(rc);
      return false;
    }
    return true;
  };

  if (!setOption("terminal", "no") ||
      !setOption("msg-level", "all=warn") ||
      !setOption("input-default-bindings", "no") ||
      !setOption("audio", "no") ||
      !setOption("keep-open", "yes") ||
      !setOption("image-display-duration", "inf") ||
      !setOption("hwdec", "no") ||
      !setOption("vo", "libmpv")) {
    cleanup();
    Throw(env, error);
    return nullptr;
  }

  int rc = gMpv.initialize(handle);
  if (rc < 0) {
    error = "mpv_initialize failed: " + MpvError(rc);
    cleanup();
    Throw(env, error);
    return nullptr;
  }

  mpv_d3d11_init_params initParams{};
  initParams.device = d3d.device.Get();
  const char* apiType = MPV_RENDER_API_TYPE_D3D11;
  mpv_render_param createParams[] = {
    {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(apiType)},
    {MPV_RENDER_PARAM_D3D11_INIT_PARAMS, &initParams},
    {MPV_RENDER_PARAM_INVALID, nullptr}
  };
  rc = gMpv.render_context_create(&render, handle, createParams);
  if (rc < 0 || !render) {
    error = "mpv_render_context_create(d3d11) failed: " + MpvError(rc);
    cleanup();
    Throw(env, error);
    return nullptr;
  }

  const char* cmd[] = {"loadfile", mediaPath.c_str(), "replace", nullptr};
  rc = gMpv.command(handle, cmd);
  if (rc < 0) {
    error = "loadfile failed: " + MpvError(rc);
    cleanup();
    Throw(env, error);
    return nullptr;
  }

  bool fileLoaded = false;
  bool rendered = false;
  uint64_t lastFlags = 0;
  auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(8);
  while (std::chrono::steady_clock::now() < deadline && !rendered) {
    mpv_event* event = gMpv.wait_event(handle, 0.02);
    if (event && event->event_id == MPV_EVENT_FILE_LOADED) fileLoaded = true;
    if (event && event->event_id == MPV_EVENT_END_FILE && !fileLoaded) {
      error = "mpv ended file before FILE_LOADED";
      break;
    }

    lastFlags = gMpv.render_context_update(render);
    if ((lastFlags & MPV_RENDER_UPDATE_FRAME) || fileLoaded) {
      mpv_d3d11_fbo fbo{};
      fbo.tex = d3d.target.Get();
      mpv_render_param renderParams[] = {
        {MPV_RENDER_PARAM_D3D11_FBO, &fbo},
        {MPV_RENDER_PARAM_INVALID, nullptr}
      };
      rc = gMpv.render_context_render(render, renderParams);
      if (rc < 0) {
        error = "mpv_render_context_render(d3d11) failed: " + MpvError(rc);
        break;
      }
      rendered = true;
      break;
    }
    std::this_thread::sleep_for(std::chrono::milliseconds(10));
  }

  if (!rendered) {
    if (error.empty()) error = "timed out waiting for libmpv D3D11 frame";
    cleanup();
    Throw(env, error);
    return nullptr;
  }

  uint8_t r = 0, g = 0, b = 0, a = 0;
  if (!SampleCenter(&d3d, &r, &g, &b, &a, &error)) {
    cleanup();
    Throw(env, error);
    return nullptr;
  }

  const uint64_t apiVersion = gMpv.client_api_version();
  cleanup();

  napi_value out;
  napi_create_object(env, &out);
  napi_set_named_property(env, out, "ok", MakeBool(env, true));
  napi_set_named_property(env, out, "fileLoaded", MakeBool(env, fileLoaded));
  napi_set_named_property(env, out, "rendered", MakeBool(env, rendered));
  napi_set_named_property(env, out, "deviceMode", MakeString(env, d3d.deviceMode));
  napi_set_named_property(env, out, "featureLevel", MakeString(env, FeatureLevelText(d3d.featureLevel)));
  napi_set_named_property(env, out, "sharedHandleBytes", MakeUint32(env, static_cast<uint32_t>(sizeof(HANDLE))));
  napi_set_named_property(env, out, "renderUpdateFlags", MakeDouble(env, static_cast<double>(lastFlags)));
  napi_set_named_property(env, out, "mpvClientApiVersion", MakeDouble(env, static_cast<double>(apiVersion)));

  napi_value sample;
  napi_create_object(env, &sample);
  napi_set_named_property(env, sample, "r", MakeUint32(env, r));
  napi_set_named_property(env, sample, "g", MakeUint32(env, g));
  napi_set_named_property(env, sample, "b", MakeUint32(env, b));
  napi_set_named_property(env, sample, "a", MakeUint32(env, a));
  napi_set_named_property(env, out, "sample", sample);
  return out;
}

void Cleanup(void*) {
  if (gMpv.module) {
    FreeLibrary(gMpv.module);
    gMpv = {};
  }
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"smokeRender", nullptr, SmokeRender, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, std::size(props), props);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}

}  // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

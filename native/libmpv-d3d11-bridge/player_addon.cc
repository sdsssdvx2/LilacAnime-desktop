#include <node_api.h>
#include <windows.h>
#include <d3d11.h>
#include <dxgi1_2.h>
#include <wrl/client.h>

#include <mpv/client.h>
#include <mpv/render.h>
#include <mpv/render_d3d11.h>

#include <array>
#include <chrono>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <iterator>
#include <memory>
#include <mutex>
#include <sstream>
#include <string>
#include <unordered_map>
#include <vector>

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
  decltype(&mpv_get_property) get_property = nullptr;
  decltype(&mpv_get_property_string) get_property_string = nullptr;
  decltype(&mpv_free) free_value = nullptr;
  decltype(&mpv_render_context_create) render_context_create = nullptr;
  decltype(&mpv_render_context_update) render_context_update = nullptr;
  decltype(&mpv_render_context_render) render_context_render = nullptr;
  decltype(&mpv_render_context_free) render_context_free = nullptr;
};

MpvApi gMpv;
std::mutex gMutex;
uint32_t gNextPlayerId = 1;

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
  LOAD_MPV("mpv_get_property", get_property);
  LOAD_MPV("mpv_get_property_string", get_property_string);
  LOAD_MPV("mpv_free", free_value);
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

bool ReadUint32(napi_env env, napi_value value, uint32_t* out) {
  return napi_get_value_uint32(env, value, out) == napi_ok;
}

napi_value StringValue(napi_env env, const std::string& value) {
  napi_value out;
  napi_create_string_utf8(env, value.c_str(), value.size(), &out);
  return out;
}

napi_value BoolValue(napi_env env, bool value) {
  napi_value out;
  napi_get_boolean(env, value, &out);
  return out;
}

napi_value Uint32Value(napi_env env, uint32_t value) {
  napi_value out;
  napi_create_uint32(env, value, &out);
  return out;
}

napi_value DoubleValue(napi_env env, double value) {
  napi_value out;
  napi_create_double(env, value, &out);
  return out;
}

napi_value NullValue(napi_env env) {
  napi_value out;
  napi_get_null(env, &out);
  return out;
}

void Set(napi_env env, napi_value object, const char* key, napi_value value) {
  napi_set_named_property(env, object, key, value);
}

struct TextureSlot {
  ComPtr<ID3D11Texture2D> texture;
  HANDLE sharedHandle = nullptr;
  uint32_t width = 0;
  uint32_t height = 0;
  bool inFlight = false;
  uint64_t frameId = 0;

  ~TextureSlot() { Reset(); }

  void Reset() {
    if (sharedHandle) {
      CloseHandle(sharedHandle);
      sharedHandle = nullptr;
    }
    texture.Reset();
    width = 0;
    height = 0;
    inFlight = false;
    frameId = 0;
  }
};

struct Player {
  uint32_t id = 0;
  mpv_handle* handle = nullptr;
  mpv_render_context* render = nullptr;
  ComPtr<ID3D11Device> device;
  ComPtr<ID3D11DeviceContext> context;
  D3D_FEATURE_LEVEL featureLevel = D3D_FEATURE_LEVEL_9_1;
  std::string deviceMode = "none";
  std::array<TextureSlot, 3> slots;
  uint64_t nextFrameId = 1;
  uint64_t renderedFrames = 0;
  uint64_t droppedForBackpressure = 0;
  bool fileLoaded = false;
  bool eof = false;
  std::string lastError;

  ~Player() { Destroy(); }

  void Destroy() {
    if (render) {
      gMpv.render_context_free(render);
      render = nullptr;
    }
    if (handle) {
      gMpv.terminate_destroy(handle);
      handle = nullptr;
    }
    for (auto& slot : slots) slot.Reset();
    context.Reset();
    device.Reset();
  }
};

std::unordered_map<uint32_t, std::unique_ptr<Player>> gPlayers;

bool SetOption(Player* player, const char* key, const char* value, std::string* error) {
  int rc = gMpv.set_option_string(player->handle, key, value);
  if (rc < 0) {
    *error = std::string("mpv_set_option_string(") + key + ") failed: " + MpvError(rc);
    return false;
  }
  return true;
}

bool InitDevice(Player* player, std::string* error) {
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
    &player->device, &actual, &player->context);
  if (SUCCEEDED(hr)) {
    player->deviceMode = "hardware";
  } else {
    player->device.Reset();
    player->context.Reset();
    hr = D3D11CreateDevice(
      nullptr, D3D_DRIVER_TYPE_WARP, nullptr, flags,
      levels, static_cast<UINT>(std::size(levels)), D3D11_SDK_VERSION,
      &player->device, &actual, &player->context);
    if (FAILED(hr)) {
      *error = "D3D11CreateDevice failed " + HrHex(hr);
      return false;
    }
    player->deviceMode = "warp";
  }
  player->featureLevel = actual;
  return true;
}

bool EnsureTexture(Player* player, TextureSlot* slot, uint32_t width, uint32_t height, std::string* error) {
  if (slot->texture && slot->width == width && slot->height == height) return true;
  if (slot->inFlight) {
    *error = "attempted to resize an in-flight shared texture";
    return false;
  }
  slot->Reset();

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

  HRESULT hr = player->device->CreateTexture2D(&desc, nullptr, &slot->texture);
  if (FAILED(hr)) {
    *error = "CreateTexture2D failed " + HrHex(hr);
    return false;
  }

  ComPtr<IDXGIResource1> dxgi;
  hr = slot->texture.As(&dxgi);
  if (FAILED(hr)) {
    *error = "Query IDXGIResource1 failed " + HrHex(hr);
    return false;
  }
  hr = dxgi->CreateSharedHandle(
    nullptr,
    DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE,
    nullptr,
    &slot->sharedHandle);
  if (FAILED(hr) || !slot->sharedHandle) {
    *error = "CreateSharedHandle failed " + HrHex(hr);
    return false;
  }
  slot->width = width;
  slot->height = height;
  return true;
}

bool SampleTexture(Player* player, TextureSlot* slot, uint8_t* r, uint8_t* g, uint8_t* b, uint8_t* a, std::string* error) {
  if (!slot->texture) {
    *error = "texture slot is empty";
    return false;
  }
  D3D11_TEXTURE2D_DESC desc{};
  slot->texture->GetDesc(&desc);
  desc.Usage = D3D11_USAGE_STAGING;
  desc.BindFlags = 0;
  desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  desc.MiscFlags = 0;
  ComPtr<ID3D11Texture2D> staging;
  HRESULT hr = player->device->CreateTexture2D(&desc, nullptr, &staging);
  if (FAILED(hr)) {
    *error = "Create staging texture failed " + HrHex(hr);
    return false;
  }
  player->context->CopyResource(staging.Get(), slot->texture.Get());
  D3D11_MAPPED_SUBRESOURCE mapped{};
  hr = player->context->Map(staging.Get(), 0, D3D11_MAP_READ, 0, &mapped);
  if (FAILED(hr)) {
    *error = "Map staging texture failed " + HrHex(hr);
    return false;
  }
  const uint32_t x = slot->width / 2;
  const uint32_t y = slot->height / 2;
  const uint8_t* p = static_cast<const uint8_t*>(mapped.pData) + static_cast<size_t>(y) * mapped.RowPitch + static_cast<size_t>(x) * 4;
  *b = p[0];
  *g = p[1];
  *r = p[2];
  *a = p[3];
  player->context->Unmap(staging.Get(), 0);
  return true;
}

void DrainEvents(Player* player) {
  if (!player || !player->handle) return;
  for (;;) {
    mpv_event* event = gMpv.wait_event(player->handle, 0);
    if (!event || event->event_id == MPV_EVENT_NONE) break;
    if (event->event_id == MPV_EVENT_FILE_LOADED) {
      player->fileLoaded = true;
      player->eof = false;
    } else if (event->event_id == MPV_EVENT_END_FILE) {
      player->eof = true;
    } else if (event->event_id == MPV_EVENT_SHUTDOWN) {
      player->eof = true;
    }
    if (event->error < 0) player->lastError = MpvError(event->error);
  }
}

Player* FindPlayer(uint32_t id) {
  auto it = gPlayers.find(id);
  return it == gPlayers.end() ? nullptr : it->second.get();
}

bool GetDoubleProperty(Player* player, const char* name, double* out) {
  return gMpv.get_property(player->handle, name, MPV_FORMAT_DOUBLE, out) >= 0;
}

bool GetInt64Property(Player* player, const char* name, int64_t* out) {
  return gMpv.get_property(player->handle, name, MPV_FORMAT_INT64, out) >= 0;
}

bool GetFlagProperty(Player* player, const char* name, bool* out) {
  int flag = 0;
  if (gMpv.get_property(player->handle, name, MPV_FORMAT_FLAG, &flag) < 0) return false;
  *out = flag != 0;
  return true;
}

bool GetStringProperty(Player* player, const char* name, std::string* out) {
  char* value = gMpv.get_property_string(player->handle, name);
  if (!value) return false;
  *out = value;
  gMpv.free_value(value);
  return true;
}

void SetMaybeDouble(napi_env env, napi_value object, const char* key, Player* player, const char* property) {
  double value = 0;
  Set(env, object, key, GetDoubleProperty(player, property, &value) ? DoubleValue(env, value) : NullValue(env));
}

void SetMaybeInt64(napi_env env, napi_value object, const char* key, Player* player, const char* property) {
  int64_t value = 0;
  Set(env, object, key, GetInt64Property(player, property, &value) ? DoubleValue(env, static_cast<double>(value)) : NullValue(env));
}

void SetMaybeFlag(napi_env env, napi_value object, const char* key, Player* player, const char* property) {
  bool value = false;
  Set(env, object, key, GetFlagProperty(player, property, &value) ? BoolValue(env, value) : NullValue(env));
}

void SetMaybeString(napi_env env, napi_value object, const char* key, Player* player, const char* property) {
  std::string value;
  Set(env, object, key, GetStringProperty(player, property, &value) ? StringValue(env, value) : NullValue(env));
}

napi_value CreatePlayer(napi_env env, napi_callback_info info) {
  std::lock_guard<std::mutex> lock(gMutex);
  std::string error;
  if (!LoadMpv(&error)) {
    Throw(env, error);
    return nullptr;
  }

  auto player = std::make_unique<Player>();
  player->id = gNextPlayerId++;
  if (!InitDevice(player.get(), &error)) {
    Throw(env, error);
    return nullptr;
  }

  player->handle = gMpv.create();
  if (!player->handle) {
    Throw(env, "mpv_create failed");
    return nullptr;
  }

  const std::pair<const char*, const char*> options[] = {
    {"terminal", "no"},
    {"msg-level", "all=warn"},
    {"input-default-bindings", "no"},
    {"keep-open", "yes"},
    {"audio-display", "no"},
    {"vo", "libmpv"},
    {"hwdec", "auto-safe"}
  };
  for (const auto& option : options) {
    if (!SetOption(player.get(), option.first, option.second, &error)) {
      Throw(env, error);
      return nullptr;
    }
  }

  int rc = gMpv.initialize(player->handle);
  if (rc < 0) {
    Throw(env, "mpv_initialize failed: " + MpvError(rc));
    return nullptr;
  }

  mpv_d3d11_init_params initParams{};
  initParams.device = player->device.Get();
  const char* apiType = MPV_RENDER_API_TYPE_D3D11;
  mpv_render_param params[] = {
    {MPV_RENDER_PARAM_API_TYPE, const_cast<char*>(apiType)},
    {MPV_RENDER_PARAM_D3D11_INIT_PARAMS, &initParams},
    {MPV_RENDER_PARAM_INVALID, nullptr}
  };
  rc = gMpv.render_context_create(&player->render, player->handle, params);
  if (rc < 0 || !player->render) {
    Throw(env, "mpv_render_context_create(d3d11) failed: " + MpvError(rc));
    return nullptr;
  }

  const uint32_t id = player->id;
  const std::string deviceMode = player->deviceMode;
  const std::string featureLevel = FeatureLevelText(player->featureLevel);
  gPlayers.emplace(id, std::move(player));

  napi_value out;
  napi_create_object(env, &out);
  Set(env, out, "playerId", Uint32Value(env, id));
  Set(env, out, "deviceMode", StringValue(env, deviceMode));
  Set(env, out, "featureLevel", StringValue(env, featureLevel));
  Set(env, out, "mpvClientApiVersion", DoubleValue(env, static_cast<double>(gMpv.client_api_version())));
  return out;
}

napi_value Open(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  std::string source;
  if (argc < 2 || !ReadUint32(env, argv[0], &id) || !ReadUtf8(env, argv[1], &source)) {
    Throw(env, "open(playerId, source) requires id and string source");
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) {
    Throw(env, "unknown player id");
    return nullptr;
  }
  const char* args[] = {"loadfile", source.c_str(), "replace", nullptr};
  int rc = gMpv.command(player->handle, args);
  if (rc < 0) {
    Throw(env, "loadfile failed: " + MpvError(rc));
    return nullptr;
  }
  player->fileLoaded = false;
  player->eof = false;
  player->lastError.clear();
  return BoolValue(env, true);
}

napi_value Command(napi_env env, napi_callback_info info) {
  size_t argc = 2;
  napi_value argv[2];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  bool isArray = false;
  if (argc < 2 || !ReadUint32(env, argv[0], &id) || napi_is_array(env, argv[1], &isArray) != napi_ok || !isArray) {
    Throw(env, "command(playerId, stringArray) requires id and array");
    return nullptr;
  }

  uint32_t length = 0;
  napi_get_array_length(env, argv[1], &length);
  if (!length || length > 32) {
    Throw(env, "command array must contain 1..32 strings");
    return nullptr;
  }
  std::vector<std::string> storage;
  storage.reserve(length);
  for (uint32_t i = 0; i < length; i += 1) {
    napi_value item;
    napi_get_element(env, argv[1], i, &item);
    std::string text;
    if (!ReadUtf8(env, item, &text)) {
      Throw(env, "command arguments must already be strings");
      return nullptr;
    }
    storage.push_back(std::move(text));
  }
  std::vector<const char*> args;
  args.reserve(storage.size() + 1);
  for (const auto& item : storage) args.push_back(item.c_str());
  args.push_back(nullptr);

  std::lock_guard<std::mutex> lock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) {
    Throw(env, "unknown player id");
    return nullptr;
  }
  int rc = gMpv.command(player->handle, args.data());
  if (rc < 0) {
    Throw(env, "mpv_command failed: " + MpvError(rc));
    return nullptr;
  }
  return BoolValue(env, true);
}

napi_value Poll(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  if (argc < 1 || !ReadUint32(env, argv[0], &id)) {
    Throw(env, "poll(playerId) requires id");
    return nullptr;
  }

  std::lock_guard<std::mutex> lock(gMutex);
  Player* player = FindPlayer(id);
  if (!player) {
    Throw(env, "unknown player id");
    return nullptr;
  }
  DrainEvents(player);

  napi_value out;
  napi_create_object(env, &out);
  Set(env, out, "fileLoaded", BoolValue(env, player->fileLoaded));
  Set(env, out, "eof", BoolValue(env, player->eof));
  Set(env, out, "lastError", player->lastError.empty() ? NullValue(env) : StringValue(env, player->lastError));
  Set(env, out, "renderedFrames", DoubleValue(env, static_cast<double>(player->renderedFrames)));
  Set(env, out, "backpressureDrops", DoubleValue(env, static_cast<double>(player->droppedForBackpressure)));
  SetMaybeDouble(env, out, "time", player, "time-pos");
  SetMaybeDouble(env, out, "duration", player, "duration");
  SetMaybeDouble(env, out, "fps", player, "container-fps");
  SetMaybeInt64(env, out, "width", player, "width");
  SetMaybeInt64(env, out, "height", player, "height");
  SetMaybeFlag(env, out, "paused", player, "pause");
  SetMaybeFlag(env, out, "pausedForCache", player, "paused-for-cache");
  SetMaybeString(env, out, "videoCodec", player, "video-codec");
  SetMaybeString(env, out, "audioCodec", player, "audio-codec");
  SetMaybeString(env, out, "vid", player, "vid");
  SetMaybeString(env, out, "aid", player, "aid");
  SetMaybeString(env, out, "hwdecCurrent", player, "hwdec-current");
  return out;
}

napi_value RenderFrame(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0, width = 0, height = 0;
  if (argc < 3 || !ReadUint32(env, argv[0], &id) || !ReadUint32(env, argv[1], &width) || !ReadUint32(env, argv[2], &height)) {
    Throw(env, "renderFrame(playerId, width, height) requires integers");
    return nullptr;
  }
  width = (std::max)(2u, (std::min)(width, 3840u));
  height = (std::max)(2u, (std::min)(height, 2160u));

  std::lock_guard<std::mutex> lock(gMutex);
  Player* player = FindPlayer(id);
  if (!player || !player->render) {
    Throw(env, "unknown or uninitialized player id");
    return nullptr;
  }
  DrainEvents(player);
  const uint64_t flags = gMpv.render_context_update(player->render);

  napi_value out;
  napi_create_object(env, &out);
  Set(env, out, "updateFlags", DoubleValue(env, static_cast<double>(flags)));
  if (!(flags & MPV_RENDER_UPDATE_FRAME)) {
    Set(env, out, "updated", BoolValue(env, false));
    return out;
  }

  TextureSlot* slot = nullptr;
  uint32_t slotId = 0;
  for (uint32_t i = 0; i < player->slots.size(); i += 1) {
    if (!player->slots[i].inFlight) {
      slot = &player->slots[i];
      slotId = i;
      break;
    }
  }
  if (!slot) {
    player->droppedForBackpressure += 1;
    Set(env, out, "updated", BoolValue(env, false));
    Set(env, out, "backpressure", BoolValue(env, true));
    return out;
  }

  std::string error;
  if (!EnsureTexture(player, slot, width, height, &error)) {
    Throw(env, error);
    return nullptr;
  }

  mpv_d3d11_fbo fbo{};
  fbo.tex = slot->texture.Get();
  int blockForTargetTime = 0;
  mpv_render_param params[] = {
    {MPV_RENDER_PARAM_D3D11_FBO, &fbo},
    {MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &blockForTargetTime},
    {MPV_RENDER_PARAM_INVALID, nullptr}
  };
  int rc = gMpv.render_context_render(player->render, params);
  if (rc < 0) {
    Throw(env, "mpv_render_context_render(d3d11) failed: " + MpvError(rc));
    return nullptr;
  }

  slot->inFlight = true;
  slot->frameId = player->nextFrameId++;
  player->renderedFrames += 1;

  napi_value handleBuffer;
  void* copied = nullptr;
  napi_create_buffer_copy(env, sizeof(HANDLE), &slot->sharedHandle, &copied, &handleBuffer);
  const auto now = std::chrono::steady_clock::now().time_since_epoch();
  const double timestampUs = static_cast<double>(std::chrono::duration_cast<std::chrono::microseconds>(now).count());

  Set(env, out, "updated", BoolValue(env, true));
  Set(env, out, "backpressure", BoolValue(env, false));
  Set(env, out, "slotId", Uint32Value(env, slotId));
  Set(env, out, "frameId", DoubleValue(env, static_cast<double>(slot->frameId)));
  Set(env, out, "width", Uint32Value(env, width));
  Set(env, out, "height", Uint32Value(env, height));
  Set(env, out, "pixelFormat", StringValue(env, "bgra"));
  Set(env, out, "ntHandle", handleBuffer);
  Set(env, out, "timestampUs", DoubleValue(env, timestampUs));
  return out;
}

napi_value ReleaseFrame(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0, slotId = 0;
  double frameIdNumber = 0;
  if (argc < 3 || !ReadUint32(env, argv[0], &id) || !ReadUint32(env, argv[1], &slotId) || napi_get_value_double(env, argv[2], &frameIdNumber) != napi_ok) {
    return BoolValue(env, false);
  }
  std::lock_guard<std::mutex> lock(gMutex);
  Player* player = FindPlayer(id);
  if (!player || slotId >= player->slots.size()) return BoolValue(env, false);
  TextureSlot& slot = player->slots[slotId];
  const uint64_t frameId = static_cast<uint64_t>(frameIdNumber);
  if (!slot.inFlight || slot.frameId != frameId) return BoolValue(env, false);
  slot.inFlight = false;
  return BoolValue(env, true);
}

napi_value SampleFrame(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0, slotId = 0;
  double frameIdNumber = 0;
  if (argc < 3 || !ReadUint32(env, argv[0], &id) || !ReadUint32(env, argv[1], &slotId) || napi_get_value_double(env, argv[2], &frameIdNumber) != napi_ok) {
    Throw(env, "sampleFrame(playerId, slotId, frameId) requires ids");
    return nullptr;
  }
  std::lock_guard<std::mutex> lock(gMutex);
  Player* player = FindPlayer(id);
  if (!player || slotId >= player->slots.size()) {
    Throw(env, "unknown player or slot");
    return nullptr;
  }
  TextureSlot& slot = player->slots[slotId];
  if (slot.frameId != static_cast<uint64_t>(frameIdNumber)) {
    Throw(env, "frame id no longer matches slot");
    return nullptr;
  }
  uint8_t r = 0, g = 0, b = 0, a = 0;
  std::string error;
  if (!SampleTexture(player, &slot, &r, &g, &b, &a, &error)) {
    Throw(env, error);
    return nullptr;
  }
  napi_value out;
  napi_create_object(env, &out);
  Set(env, out, "r", Uint32Value(env, r));
  Set(env, out, "g", Uint32Value(env, g));
  Set(env, out, "b", Uint32Value(env, b));
  Set(env, out, "a", Uint32Value(env, a));
  return out;
}

napi_value DestroyPlayer(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0;
  if (argc < 1 || !ReadUint32(env, argv[0], &id)) return BoolValue(env, false);
  std::unique_ptr<Player> player;
  {
    std::lock_guard<std::mutex> lock(gMutex);
    auto it = gPlayers.find(id);
    if (it == gPlayers.end()) return BoolValue(env, false);
    player = std::move(it->second);
    gPlayers.erase(it);
  }
  player.reset();
  return BoolValue(env, true);
}

void Cleanup(void*) {
  std::unordered_map<uint32_t, std::unique_ptr<Player>> players;
  {
    std::lock_guard<std::mutex> lock(gMutex);
    players.swap(gPlayers);
  }
  players.clear();
}

napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor props[] = {
    {"createPlayer", nullptr, CreatePlayer, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"open", nullptr, Open, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"command", nullptr, Command, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"poll", nullptr, Poll, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"renderFrame", nullptr, RenderFrame, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"releaseFrame", nullptr, ReleaseFrame, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"sampleFrame", nullptr, SampleFrame, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"destroyPlayer", nullptr, DestroyPlayer, nullptr, nullptr, nullptr, napi_default, nullptr}
  };
  napi_define_properties(env, exports, std::size(props), props);
  napi_add_env_cleanup_hook(env, Cleanup, nullptr);
  return exports;
}

} // namespace

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)

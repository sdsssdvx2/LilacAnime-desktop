{
  "targets": [
    {
      "target_name": "lilac_shared_texture_probe",
      "sources": ["addon.cc"],
      "defines": ["NAPI_VERSION=8", "NOMINMAX", "WIN32_LEAN_AND_MEAN"],
      "libraries": ["d3d11.lib", "dxgi.lib", "user32.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++17"]
        }
      }
    }
  ]
}

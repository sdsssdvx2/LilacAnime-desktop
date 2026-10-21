{
  "targets": [
    {
      "target_name": "lilac_libmpv_d3d11_bridge",
      "sources": ["addon.cc"],
      "include_dirs": ["vendor/include"],
      "defines": ["NAPI_VERSION=8", "NOMINMAX", "WIN32_LEAN_AND_MEAN"],
      "libraries": ["d3d11.lib", "dxgi.lib"],
      "msvs_settings": {
        "VCCLCompilerTool": {
          "AdditionalOptions": ["/std:c++17"]
        }
      }
    }
  ]
}

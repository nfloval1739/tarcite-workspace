# -*- mode: python ; coding: utf-8 -*-
"""
PyInstaller spec for TarCite Workspace.

Build from the project root:
    pyinstaller citation.spec
"""

import os
import sys
from pathlib import Path
from PyInstaller.utils.hooks import collect_data_files, collect_all, collect_submodules

# ---------------------------------------------------------------------------
# Version info (Windows)
# ---------------------------------------------------------------------------

APP_VERSION = (0, 2, 26, 0)
APP_VERSION_STR = "0.2.26"

win_version_info = None
if sys.platform == "win32":
    from PyInstaller.utils.win32.versioninfo import (
        VSVersionInfo, FixedFileInfo, StringFileInfo, StringTable,
        StringStruct, VarFileInfo, VarStruct,
    )
    win_version_info = VSVersionInfo(
        ffi=FixedFileInfo(
            filevers=APP_VERSION,
            prodvers=APP_VERSION,
            mask=0x3F,
            flags=0x0,
            OS=0x40004,
            fileType=0x1,
            subtype=0x0,
            date=(0, 0),
        ),
        kids=[
            StringFileInfo([
                StringTable(
                    "040904B0",
                    [
                        StringStruct("CompanyName", "Naufal Naufal"),
                        StringStruct("FileDescription", "TarCite Workspace — Research Tools and Local Assistant"),
                        StringStruct("FileVersion", APP_VERSION_STR),
                        StringStruct("InternalName", "TarCiteWorkspace"),
                        StringStruct("LegalCopyright", "Copyright (c) 2026 Naufal Naufal"),
                        StringStruct("OriginalFilename", "TarCiteWorkspace.exe"),
                        StringStruct("ProductName", "TarCite Workspace"),
                        StringStruct("ProductVersion", APP_VERSION_STR),
                    ],
                ),
            ]),
            VarFileInfo([VarStruct("Translation", [1033, 1200])]),
        ],
    )

# ---------------------------------------------------------------------------
# Package collection
# ---------------------------------------------------------------------------

st_datas, st_bins, st_hidden = collect_all("sentence_transformers")
xf_datas, xf_bins, xf_hidden = collect_all("transformers")
tk_datas, tk_bins, tk_hidden = collect_all("tokenizers")
ch_datas, ch_bins, ch_hidden = collect_all("chromadb")
wv_datas, wv_bins, wv_hidden = collect_all("webview")
ps_datas, ps_bins, ps_hidden = collect_all("pystray")

# ---------------------------------------------------------------------------
# App source data — static files, templates, CSL styles, Word add-in
# Never include .env or data/ (user config/DB lives in user data dir)
# ---------------------------------------------------------------------------

app_datas = [
    ("app/static",    "app/static"),
    ("app/templates", "app/templates"),
    ("app/csl",       "app/csl"),
    ("word-addin",    "word-addin"),
]

# Pre-downloaded HF embedding/reranker models (run packaging/download_models.py first)
models_src = Path("packaging/models")
if models_src.exists():
    app_datas.append((str(models_src), "models"))

# Bundled Ollama binary (run packaging/download_ollama.bat first)
# Platform-specific folders keep builds from cross-contaminating
_ollama_platform = {"win32": "win", "darwin": "mac"}.get(sys.platform, "linux")
_ollama_dir = f"packaging/ollama_{_ollama_platform}"
ollama_src = Path(_ollama_dir)
if ollama_src.exists():
    app_datas.append((str(ollama_src), "ollama"))

# Pre-pulled Ollama model blobs (run packaging/download_ollama.bat first)
ollama_models_src = Path("packaging/ollama_models")
if ollama_models_src.exists():
    app_datas.append((str(ollama_models_src), "ollama_models"))

all_datas = (
    app_datas
    + st_datas
    + xf_datas
    + tk_datas
    + ch_datas
    + wv_datas
    + ps_datas
    + collect_data_files("huggingface_hub")
    + collect_data_files("filelock")
    + collect_data_files("tqdm")
    + collect_data_files("citeproc")
)

all_bins = st_bins + xf_bins + tk_bins + ch_bins + wv_bins + ps_bins

all_hidden = (
    st_hidden + xf_hidden + tk_hidden + ch_hidden + wv_hidden + ps_hidden
    + collect_submodules("uvicorn")
    + collect_submodules("fastapi")
    + collect_submodules("anyio")
    + collect_submodules("starlette")
    + collect_submodules("argostranslate")
    + collect_submodules("mcp")
    + collect_submodules("sse_starlette")
    + [
        # MCP server transitive deps (not auto-detected via lazy imports)
        "httpx_sse", "pydantic_settings",
        # app modules
        "app", "app.main", "app.config", "app.database", "app.embeddings",
        "app.mcp_server",
        "app.retrieval", "app.reranker", "app.sync", "app.chunking",
        "app.local_scanner", "app.crossref", "app.ai_client",
        "app.citation_formatter", "app.csl_engine", "app.word_connector_api",
        "app.word_connector_db", "app.word_connector_installer",
        "app.word_csl_formatter", "app.word_docx_scanner",
        "app.prompts", "app.schemas", "app.backup", "app.downloader",
        "app.translation", "app.zotero_importer", "app.mendeley_importer",
        # native window
        "PIL", "PIL.Image",
        "webview", "pystray",
        # server
        "multipart", "aiofiles",
        "h11", "httptools", "websockets",
        # ML
        "torch", "torch.nn", "torch.nn.functional",
        "torch.backends", "torch.backends.cpu",
        "onnxruntime", "onnxruntime.backend",
        # transformers core + auto modules (lazy import resolution)
        "transformers", "transformers.models", "transformers.models.auto",
        "transformers.models.auto.modeling_auto", "transformers.models.auto.tokenization_auto",
        "transformers.models.auto.configuration_auto", "transformers.models.auto.processing_auto",
        "transformers.models.auto.image_processing_auto", "transformers.models.auto.feature_extraction_auto",
        "transformers.modeling_utils", "transformers.configuration_utils",
        "transformers.tokenization_utils", "transformers.tokenization_utils_base",
        "transformers.tokenization_utils_fast",
        "transformers.models.bert", "transformers.models.bert.modeling_bert",
        "transformers.models.bert.configuration_bert", "transformers.models.bert.tokenization_bert",
        "transformers.models.bert.tokenization_bert_fast",
        "transformers.models.roberta", "transformers.models.roberta.modeling_roberta",
        "transformers.models.roberta.configuration_roberta", "transformers.models.roberta.tokenization_roberta",
        "transformers.models.roberta.tokenization_roberta_fast",
        "transformers.models.xlm_roberta", "transformers.models.xlm_roberta.modeling_xlm_roberta",
        "transformers.models.xlm_roberta.configuration_xlm_roberta",
        "transformers.models.distilbert", "transformers.models.distilbert.modeling_distilbert",
        "transformers.models.distilbert.configuration_distilbert",
        "transformers.models.camembert", "transformers.models.camembert.modeling_camembert",
        "transformers.models.camembert.configuration_camembert",
        "transformers.conversion_mapping", "transformers.core_model_loading",
        "transformers.distributed", "transformers.initialization",
        "transformers.generation", "transformers.dynamic_module_utils",
        "transformers.integrations", "transformers.integrations.accelerate",
        "transformers.integrations.deepspeed", "transformers.integrations.peft",
        "transformers.integrations.flash_attention", "transformers.integrations.sdpa_attention",
        "transformers.integrations.flex_attention", "transformers.integrations.hub_kernels",
        "transformers.integrations.tensor_parallel", "transformers.integrations.eager_paged",
        "transformers.integrations.flash_paged", "transformers.integrations.sdpa_paged",
        "transformers.modeling_flash_attention_utils",
        # sentence-transformers
        "sentence_transformers", "sentence_transformers.models",
        "sentence_transformers.base", "sentence_transformers.base.modules",
        # PDF
        "fitz",
        # misc
        "lxml", "lxml.etree", "lxml._elementpath",
        "openai",
        "ctranslate2", "sentencepiece", "sacremoses", "minisbd",
        "dotenv",
        "cryptography", "cryptography.x509",
        "packaging", "safetensors", "safetensors.torch",
        "huggingface_hub", "huggingface_hub.utils",
        "tokenizers",
        "scikit-learn", "scipy",
        "yaml", "regex",
    ]
)

# ---------------------------------------------------------------------------
# Analysis
# ---------------------------------------------------------------------------

a = Analysis(
    ["launcher.py"],
    pathex=["."],
    binaries=all_bins,
    datas=all_datas,
    hiddenimports=all_hidden,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=["packaging/rthook_torchvision.py", "packaging/rthook_transformers.py"],
    excludes=[
        "tkinter", "matplotlib",
        "PIL.ImageTk", "PIL.ImageQt",
        "IPython", "jupyter",
    ],
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="TarCiteWorkspace",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,          # UPX can break ML libs; keep off
    console=False,      # no terminal window
    icon=(
        "app/static/logo/favicon.ico"   if sys.platform == "win32"  else
        "packaging/TarCiteWorkspace.icns" if sys.platform == "darwin" else
        None
    ),
    version=win_version_info,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    name="TarCiteWorkspace",
)

# macOS app bundle
if sys.platform == "darwin":
    app = BUNDLE(
        coll,
        name="TarCiteWorkspace.app",
        icon="packaging/TarCiteWorkspace.icns",
        bundle_identifier="com.tarcite.workspace",
        info_plist={
            "NSHighResolutionCapable": True,
            "CFBundleName": "TarCite Workspace",
            "CFBundleDisplayName": "TarCite Workspace",
            "CFBundleVersion": "0.2.26",
            "CFBundleShortVersionString": "0.2.26",
            "NSCameraUsageDescription": "",
            "NSMicrophoneUsageDescription": "",
        },
    )

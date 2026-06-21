"""
Pre-download the default ML models into packaging/models/ for bundling.
Run this once before building the package:
    python packaging/download_models.py
"""

import os
import sys
from pathlib import Path

# Download into packaging/models/ next to this script
MODELS_DIR = Path(__file__).parent / "models"
MODELS_DIR.mkdir(parents=True, exist_ok=True)

os.environ["HF_HOME"] = str(MODELS_DIR)
os.environ["SENTENCE_TRANSFORMERS_HOME"] = str(MODELS_DIR / "sentence_transformers")
os.environ["TRANSFORMERS_CACHE"] = str(MODELS_DIR / "hub")

# Read defaults from settings or use known defaults
EMBEDDING_MODEL = os.environ.get("EMBEDDING_MODEL", "BAAI/bge-large-en-v1.5")
RERANKER_MODEL = os.environ.get("RERANKER_MODEL", "BAAI/bge-reranker-base")

print(f"Downloading models to: {MODELS_DIR}")
print()

print(f"[1/2] Embedding model: {EMBEDDING_MODEL}")
try:
    from sentence_transformers import SentenceTransformer
    SentenceTransformer(EMBEDDING_MODEL, cache_folder=str(MODELS_DIR / "sentence_transformers"))
    print("      Done.")
except Exception as e:
    print(f"      ERROR: {e}")
    sys.exit(1)

print()
print(f"[2/2] Reranker model: {RERANKER_MODEL}")
try:
    from sentence_transformers import CrossEncoder
    CrossEncoder(RERANKER_MODEL, cache_folder=str(MODELS_DIR / "sentence_transformers"))
    print("      Done.")
except Exception as e:
    print(f"      ERROR: {e}")
    sys.exit(1)

print()
print("All models downloaded successfully.")
print(f"Bundle size estimate: {sum(f.stat().st_size for f in MODELS_DIR.rglob('*') if f.is_file()) / 1e9:.2f} GB")

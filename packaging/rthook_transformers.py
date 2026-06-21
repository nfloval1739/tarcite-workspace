# Runtime hook: fix transformers lazy import failures in PyInstaller bundles.
#
# transformers.modeling_utils has direct (non-lazy) imports from .integrations.*
# submodules.  In a PyInstaller bundle these can fail if required sub-modules or
# data files are missing.  When modeling_utils fails to import, the _LazyModule
# in transformers/__init__.py reports:
#   "Could not import module 'PreTrainedModel'. Are this object's requirements
#    defined correctly?"
#
# This hook pre-imports critical transformers modules early so that:
# 1. Any import errors surface here with full tracebacks in the log, rather than
#    later inside the lazy loader where they are wrapped in an unhelpful message.
# 2. The modules are cached in sys.modules before sentence-transformers needs them,
#    avoiding race conditions or repeated import attempts.
#
# IMPORTANT: Do NOT stub optional dependencies (accelerate, deepspeed, peft, etc.).
# transformers uses importlib.util.find_spec() to check for these, and correctly
# skips them when absent.  Stubbing defeats those checks and causes KeyErrors in
# PACKAGE_DISTRIBUTION_MAPPING lookups.

import importlib
import logging
import sys
import traceback

logger = logging.getLogger("tarcite.rthook_transformers")


def _preimport_transformers():
    critical_modules = [
        "transformers",
        "transformers.utils",
        "transformers.utils.import_utils",
        "transformers.configuration_utils",
        "transformers.modeling_utils",
        "transformers.models.auto",
        "transformers.models.auto.modeling_auto",
        "transformers.models.auto.tokenization_auto",
        "transformers.models.auto.configuration_auto",
        "transformers.models.auto.processing_auto",
        "transformers.models.auto.image_processing_auto",
    ]

    for mod_name in critical_modules:
        if mod_name in sys.modules:
            continue
        try:
            importlib.import_module(mod_name)
        except Exception as exc:
            logger.warning(
                "Runtime hook: could not pre-import %s: %s\n%s",
                mod_name, exc, traceback.format_exc(),
            )


try:
    _preimport_transformers()
except Exception as exc:
    logger.warning("Runtime hook: transformers pre-import failed: %s", exc)

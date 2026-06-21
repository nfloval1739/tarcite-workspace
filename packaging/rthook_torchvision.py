# Runtime hook: fix torchvision _meta_registrations crash in PyInstaller bundles.
#
# The _torchvision C extension is not included in the bundle (TarCite doesn't use
# torchvision directly), so torchvision::nms and related C++ operators are never
# registered. torchvision/_meta_registrations.py tries to register fake ops for
# them via @torch.library.register_fake, which raises RuntimeError when the
# operator doesn't exist.  Stubbing _meta_registrations before torchvision loads
# prevents the crash.

import sys

class _NoOp:
    def __getattr__(self, name):
        return None

sys.modules.setdefault("torchvision._meta_registrations", _NoOp())

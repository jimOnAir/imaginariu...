from .nodes import *
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# Imaginarium addition: the all-in-one "views" node (see imagi_views.py)
from .imagi_views import NODE_CLASS_MAPPINGS as _ima_nodes, NODE_DISPLAY_NAME_MAPPINGS as _ima_names

NODE_CLASS_MAPPINGS = {**NODE_CLASS_MAPPINGS, **_ima_nodes}
NODE_DISPLAY_NAME_MAPPINGS = {**NODE_DISPLAY_NAME_MAPPINGS, **_ima_names}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS"]

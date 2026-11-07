"""Minimal stand-in for `descript-audiotools` used by MOSS-SoundEffect v2's DAC VAE.

The upstream project imports only two names from that package:

    from audiotools import AudioSignal
    from audiotools.ml import BaseModel

`BaseModel` is used for its checkpoint loader (`DAC.load(...)`); `AudioSignal` is only
referenced in annotations and in the compress/decompress helpers, which the text-to-audio
pipeline never calls. This shim therefore provides a real weights loader plus a clearly
inert AudioSignal placeholder - it never claims audio I/O support. The package is not
installed (its dependency tree is large and unnecessary for inference).
"""
import inspect

import torch
from torch import nn


class AudioSignal:
    """Inert placeholder: the pipeline path never constructs one."""

    def __init__(self, *args, **kwargs):
        raise NotImplementedError("The audiotools shim cannot load or write audio; the pipeline does not use AudioSignal.")


class BaseModel(nn.Module):
    """Weights loader matching the audiotools save format `{metadata, state_dict}`."""

    @classmethod
    def load(cls, location, *args, strict: bool = False, **kwargs):
        try:
            model_dict = torch.load(location, map_location="cpu", weights_only=False)
        except Exception as exc:  # a safetensors file would be loaded by the caller instead
            raise RuntimeError(f"Could not load {location}: {exc}") from exc
        metadata = model_dict.get("metadata") or {}
        params = dict(metadata.get("kwargs") or {})
        params.update(kwargs)
        signature = inspect.signature(cls)
        params = {k: v for k, v in params.items() if k in signature.parameters}
        model = cls(**params)
        model.load_state_dict(model_dict["state_dict"], strict=strict)
        model.metadata = metadata
        model.eval()
        return model

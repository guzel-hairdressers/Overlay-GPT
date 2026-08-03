#!/usr/bin/env python3
"""Transcribe audio using mlx-whisper (Apple Silicon, fully offline)."""
import sys
import os

# Use Chinese HuggingFace mirror for fast download
os.environ["HF_ENDPOINT"] = "https://hf-mirror.com"

def apply_mlx_whisper_patch():
    """Patch mlx_whisper load_model to support model.safetensors alongside weights.safetensors."""
    try:
        import mlx.core as mx
        import mlx.nn as nn
        from pathlib import Path
        from huggingface_hub import snapshot_download
        import json
        import mlx_whisper
        import mlx_whisper.whisper as whisper
        from mlx.utils import tree_unflatten

        transcribe_mod = sys.modules.get("mlx_whisper.transcribe")
        load_models_mod = sys.modules.get("mlx_whisper.load_models")

        def custom_load_model(path_or_hf_repo, dtype=mx.float32):
            model_path = Path(path_or_hf_repo)
            if not model_path.exists():
                model_path = Path(snapshot_download(repo_id=path_or_hf_repo))

            with open(str(model_path / "config.json"), "r") as f:
                config = json.loads(f.read())
                config.pop("model_type", None)
                quantization = config.pop("quantization", None)

            model_args = whisper.ModelDimensions(**config)

            wf = model_path / "weights.safetensors"
            if not wf.exists():
                wf = model_path / "model.safetensors"
            if not wf.exists():
                wf = model_path / "weights.npz"

            weights = mx.load(str(wf))
            model = whisper.Whisper(model_args, dtype)

            if quantization is not None:
                class_predicate = (
                    lambda p, m: isinstance(m, (nn.Linear, nn.Embedding))
                    and f"{p}.scales" in weights
                )
                nn.quantize(model, **quantization, class_predicate=class_predicate)

            weights = tree_unflatten(list(weights.items()))
            model.update(weights)
            mx.eval(model.parameters())
            return model

        if load_models_mod:
            load_models_mod.load_model = custom_load_model
        if transcribe_mod:
            transcribe_mod.load_model = custom_load_model
    except Exception as e:
        print(f"WARN: Could not apply mlx_whisper patch: {e}", file=sys.stderr)

def load_audio_array(path):
    """Load audio file as numpy array without ffmpeg."""
    try:
        import warnings
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            import scipy.io.wavfile as wavfile
            sr, data = wavfile.read(path)
        if data.ndim > 1:
            data = data.mean(axis=1)  # stereo -> mono
        return data.astype("float32") / 32768.0, sr
    except Exception:
        pass

    import wave
    import numpy as np
    with wave.open(path, "rb") as wf:
        nchannels = wf.getnchannels()
        sampwidth = wf.getsampwidth()
        sr = wf.getframerate()
        nframes = wf.getnframes()
        raw = wf.readframes(nframes)
    if sampwidth == 2:
        data = np.frombuffer(raw, dtype=np.int16)
    elif sampwidth == 4:
        data = np.frombuffer(raw, dtype=np.int32)
    else:
        data = np.frombuffer(raw, dtype=np.uint8)
    if nchannels > 1:
        data = data.reshape(-1, nchannels).mean(axis=1)
    return data.astype("float32") / 32768.0, sr

MODELS = {
    "tiny": "mlx-community/whisper-tiny",
    "small": "mlx-community/whisper-small",
    "medium": "mlx-community/whisper-medium-mlx",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
    "turbo": "mlx-community/whisper-large-v3-turbo"
}

def main():
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio-file> [--model tiny|small|turbo]", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    model_name = "turbo"
    for i, arg in enumerate(sys.argv):
        if arg == "--model" and i + 1 < len(sys.argv):
            model_name = sys.argv[i + 1]

    if not os.path.exists(audio_path):
        print(f"ERROR: File not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    import mlx_whisper
    apply_mlx_whisper_patch()

    # Load audio without ffmpeg
    audio_array, sample_rate = load_audio_array(audio_path)

    # Resample to 16kHz if needed
    if sample_rate != 16000:
        import scipy.signal
        duration = len(audio_array) / sample_rate
        target_len = int(duration * 16000)
        audio_array = scipy.signal.resample(audio_array, target_len)

    model_repo = MODELS.get(model_name, MODELS["turbo"])
    
    result = None
    try:
        result = mlx_whisper.transcribe(
            audio_array,
            path_or_hf_repo=model_repo
        )
    except Exception as e:
        print(f"WARN: Model {model_repo} failed ({e}). Falling back to whisper-large-v3-turbo...", file=sys.stderr)
        try:
            result = mlx_whisper.transcribe(
                audio_array,
                path_or_hf_repo="mlx-community/whisper-large-v3-turbo"
            )
        except Exception as e2:
            print(f"WARN: whisper-large-v3-turbo failed ({e2}). Falling back to whisper-small...", file=sys.stderr)
            try:
                result = mlx_whisper.transcribe(
                    audio_array,
                    path_or_hf_repo="mlx-community/whisper-small"
                )
            except Exception as e3:
                print(f"ERROR: All Whisper models failed: {e3}", file=sys.stderr)
                sys.exit(1)

    if not result:
        print("ERROR: Transcription failed.", file=sys.stderr)
        sys.exit(1)

    text = result.get("text", "").strip()
    if not text:
        print("ERROR: No speech detected.", file=sys.stderr)
        sys.exit(1)

    print(text)

if __name__ == "__main__":
    main()

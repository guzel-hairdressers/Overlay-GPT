#!/usr/bin/env python3
"""Transcribe audio using mlx-whisper (Apple Silicon, fully offline)."""
import sys
import os

# Use HuggingFace mirror for China
os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

def load_audio_array(path):
    """Load audio file as numpy array without ffmpeg."""
    # Try scipy first (already installed with mlx-whisper)
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

    # Fallback: Python built-in wave module (WAV only)
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

def main():
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio-file>", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    if not os.path.exists(audio_path):
        print(f"ERROR: File not found: {audio_path}", file=sys.stderr)
        sys.exit(1)

    import mlx_whisper
    import numpy as np

    # Load audio without ffmpeg
    audio_array, sample_rate = load_audio_array(audio_path)

    # Resample to 16kHz if needed (mlx-whisper expects 16kHz)
    if sample_rate != 16000:
        import scipy.signal
        duration = len(audio_array) / sample_rate
        target_len = int(duration * 16000)
        audio_array = scipy.signal.resample(audio_array, target_len)

    # Use tiny model for speed
    result = mlx_whisper.transcribe(
        audio_array,
        path_or_hf_repo="mlx-community/whisper-tiny"
    )

    text = result.get("text", "").strip()
    if not text:
        print("ERROR: No speech detected.", file=sys.stderr)
        sys.exit(1)

    print(text)

if __name__ == "__main__":
    main()

"""自动监测用的转写核心：本机 SenseVoice-Small + Silero VAD，VAD 切段、长段强制切块，保留每段起止时间。
模型加载、解码、切段的代码和研究版 scripts/transcribe.py 逐字相同（开源版不带研究脚本，所以单独放一份）；
区别只在开头：路径默认值跨平台，退出效率模式只在 Windows 上做。

环境变量：
  ASR_HOME  放模型的目录，里面要有 models/sense-voice/model.int8.onnx、models/sense-voice/tokens.txt、models/silero_vad.onnx
            （默认是项目里的 asr/ 目录）
  FFMPEG    ffmpeg 可执行文件（默认用 PATH 里的 ffmpeg）

两个坑（研究期实测）：
- Windows 11 会给后台进程套上效率模式（EcoQoS），慢 4~5 倍，启动时先退出。
- VAD 的 max_speech_duration 只是软限制，连续说话会出现一两分钟的长段，时间精度不够，所以超过 chunk-max 秒的段强制等分。
"""
import os
import subprocess
from pathlib import Path

import numpy as np
import sherpa_onnx

ROOT = Path(__file__).resolve().parent.parent
ASR = Path(os.environ.get("ASR_HOME") or (ROOT / "asr"))
FFMPEG = os.environ.get("FFMPEG") or "ffmpeg"
SR = 16000


def leave_efficiency_mode():
    """Windows 上退出效率模式并调高优先级，成功返回 True；别的系统没有这回事，返回 None。"""
    if os.name != "nt":
        return None
    import ctypes
    from ctypes import wintypes

    class PowerThrottlingState(ctypes.Structure):
        _fields_ = [("Version", wintypes.ULONG), ("ControlMask", wintypes.ULONG), ("StateMask", wintypes.ULONG)]

    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.GetCurrentProcess.restype = wintypes.HANDLE
    k.SetProcessInformation.argtypes = [wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD]
    k.SetPriorityClass.argtypes = [wintypes.HANDLE, wintypes.DWORD]
    h = k.GetCurrentProcess()
    state = PowerThrottlingState(1, 0x1, 0x0)
    ok = bool(k.SetProcessInformation(h, 4, ctypes.byref(state), ctypes.sizeof(state)))
    k.SetPriorityClass(h, 0x00008000)  # ABOVE_NORMAL
    return ok


def build(threads: int):
    recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
        model=str(ASR / "models" / "sense-voice" / "model.int8.onnx"),
        tokens=str(ASR / "models" / "sense-voice" / "tokens.txt"),
        num_threads=threads, use_itn=True, debug=False,
    )
    cfg = sherpa_onnx.VadModelConfig()
    cfg.silero_vad.model = str(ASR / "models" / "silero_vad.onnx")
    cfg.silero_vad.threshold = 0.5
    cfg.silero_vad.min_speech_duration = 0.25
    cfg.silero_vad.min_silence_duration = 0.4
    cfg.silero_vad.max_speech_duration = 20
    cfg.sample_rate = SR
    return recognizer, cfg


def decode(path: Path) -> np.ndarray:
    out = subprocess.run([FFMPEG, "-hide_banner", "-loglevel", "error", "-i", str(path),
                          "-f", "s16le", "-ar", str(SR), "-ac", "1", "-"],
                         stdin=subprocess.DEVNULL, capture_output=True, check=True)
    return np.frombuffer(out.stdout, dtype=np.int16).astype(np.float32) / 32768.0


BLOCK_S = 600  # 长音频按 10 分钟一块处理：M2 实测整段送 VAD 时 42 分钟以上的文件只用满 1 个核、慢得离谱


def transcribe(samples: np.ndarray, recognizer, cfg, chunk_max: float) -> list:
    segs = []
    block = BLOCK_S * SR
    for offset in range(0, len(samples), block):
        segs += transcribe_block(samples[offset:offset + block], offset, recognizer, cfg, chunk_max)
    return segs


def transcribe_block(samples: np.ndarray, offset: int, recognizer, cfg, chunk_max: float) -> list:
    vad = sherpa_onnx.VoiceActivityDetector(cfg, buffer_size_in_seconds=len(samples) / SR + 10)
    segs = []

    def drain():
        while not vad.empty():
            seg = vad.front
            audio = np.array(seg.samples, dtype=np.float32)
            parts = max(1, int(np.ceil(len(audio) / SR / chunk_max))) if chunk_max else 1
            size = int(np.ceil(len(audio) / parts))
            for p in range(parts):
                piece = audio[p * size:(p + 1) * size]
                stream = recognizer.create_stream()
                stream.accept_waveform(SR, piece)
                recognizer.decode_stream(stream)
                text = stream.result.text.strip()
                if text:
                    start = (offset + seg.start + p * size) / SR
                    segs.append({"s": round(start, 2), "e": round(start + len(piece) / SR, 2), "text": text})
            vad.pop()

    window = cfg.silero_vad.window_size
    for i in range(0, len(samples), window):
        vad.accept_waveform(samples[i:i + window])
        drain()
    vad.flush()
    drain()
    return segs

"""自动监测用的转写进程。模型加载、解码、切段在 app/asr_core.py（和研究版 scripts/transcribe.py 逐字相同），这里负责：
- 每个文件单独 try：坏文件写 <bvid>.error.json 后跳过，不拖垮整个进程；
- 进度按行输出 JSON（event=start/done/error/exit），网页据此显示进度；
- --watch 指向采集的标记文件：文件里还没写 exit= 就继续等新音频，和采集同时跑；
- --parent 传父进程号：父进程没了就退出，不留孤儿进程；
- 结果先写 .part 再改名，读的一方不会读到半个文件。

用法（用装了 sherpa-onnx 的 Python，默认是项目里 asr/.venv 的那个；网页服务会自动起这个进程）：
  python app/asr_worker.py --audio-dir <工作区>/audio --out-dir <工作区>/asr --shard 0/3 [--threads 4] [--watch 标记文件] [--parent 进程号]
"""
import argparse
import ctypes
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import asr_core as T  # noqa: E402


def emit(**kw) -> None:
    print(json.dumps(kw, ensure_ascii=False), flush=True)


def parent_alive(pid: int) -> bool:
    if os.name != "nt":
        # macOS / Linux：信号 0 只探测、不打扰进程
        try:
            os.kill(pid, 0)
            return True
        except ProcessLookupError:
            return False
        except PermissionError:
            return True
    # Windows 上不能用 os.kill(pid, 0) 探测：它会直接结束那个进程。用 OpenProcess + GetExitCodeProcess（259 = 还在运行）
    k = ctypes.WinDLL("kernel32", use_last_error=True)
    k.OpenProcess.restype = ctypes.c_void_p
    h = k.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        return False
    code = ctypes.c_ulong()
    ok = k.GetExitCodeProcess(ctypes.c_void_p(h), ctypes.byref(code))
    k.CloseHandle(ctypes.c_void_p(h))
    return bool(ok) and code.value == 259


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--audio-dir", required=True)
    ap.add_argument("--out-dir", required=True)
    ap.add_argument("--shard", default="0/1", help="i/n：按文件名稳定分片，多进程并行用")
    ap.add_argument("--threads", type=int, default=4)
    ap.add_argument("--chunk-max", type=float, default=12.0)
    ap.add_argument("--watch", default="", help="采集的标记文件；里面还没有 exit= 就一直等新音频")
    ap.add_argument("--parent", type=int, default=0)
    args = ap.parse_args()

    emit(event="start", efficiency=T.leave_efficiency_mode())
    recognizer, cfg = T.build(args.threads)
    shard, shards = (int(x) for x in args.shard.split("/"))
    audio_dir, out_dir = Path(args.audio_dir), Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    def pending():
        return [f for f in sorted(audio_dir.glob("*.m4a"))
                if sum(f.stem.encode()) % shards == shard
                and not (out_dir / f"{f.stem}.json").exists()
                and not (out_dir / f"{f.stem}.error.json").exists()]

    def collecting() -> bool:
        w = Path(args.watch) if args.watch else None
        return bool(w) and w.exists() and "exit=" not in w.read_text(encoding="utf-8", errors="replace")

    done = 0
    while True:
        if args.parent and not parent_alive(args.parent):
            emit(event="orphan")
            break
        files = pending()
        if not files:
            if collecting():
                time.sleep(5)
                continue
            break
        f = files[0]
        t0 = time.perf_counter()
        try:
            samples = T.decode(f)
            segs = T.transcribe(samples, recognizer, cfg, args.chunk_max)
            secs = len(samples) / T.SR
            tmp = out_dir / f"{f.stem}.json.part"
            tmp.write_text(json.dumps({"bvid": f.stem, "seconds": round(secs, 1), "chunk_max": args.chunk_max, "segments": segs},
                                      ensure_ascii=False), encoding="utf-8")
            os.replace(tmp, out_dir / f"{f.stem}.json")
            done += 1
            emit(event="done", bvid=f.stem, seconds=round(secs, 1), took=round(time.perf_counter() - t0, 1), segments=len(segs))
        except Exception as e:  # noqa: BLE001  坏文件只影响自己
            (out_dir / f"{f.stem}.error.json").write_text(
                json.dumps({"bvid": f.stem, "error": str(e)[:500], "at": time.strftime("%Y-%m-%dT%H:%M:%S")}, ensure_ascii=False),
                encoding="utf-8")
            emit(event="error", bvid=f.stem, error=str(e)[:300])
    emit(event="exit", done=done)


if __name__ == "__main__":
    main()

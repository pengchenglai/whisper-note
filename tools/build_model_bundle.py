"""把一个 sherpa-onnx 流式 transducer 模型打包成 Whisper Note 能加载的格式。

做的事情：把 encoder / decoder / joiner / tokens 四个文件首尾相接，切成 24MB 的小块
（GitHub 单个文件不能超过 100MB），并生成 manifest.json 记录每个文件在整体中的位置。

用法：
  python tools/build_model_bundle.py <模型目录> --id <模型标识> \
      --name <目录名> --style raw|punct \
      --encoder <文件名> --decoder <文件名> --joiner <文件名> [--tokens tokens.txt]

--name   输出到 local-asr/models/<目录名>/（会先清空里面旧的分块）
--style  raw   = 模型输出没有标点、英文全大写，应用会自动整理
         punct = 模型自带标点和大小写
换模型后记得把 sw.js 里的版本号加一。
"""
import argparse
import hashlib
import json
import os
import sys

PART = 24 * 1024 * 1024
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model_dir")
    ap.add_argument("--id", required=True, help="模型标识，同时用作手机上的缓存名")
    ap.add_argument("--encoder", required=True)
    ap.add_argument("--decoder", required=True)
    ap.add_argument("--joiner", required=True)
    ap.add_argument("--tokens", default="tokens.txt")
    ap.add_argument("--name", required=True, help="local-asr/models/ 下的目录名")
    ap.add_argument("--style", choices=["raw", "punct"], default="raw")
    args = ap.parse_args()
    args.out = os.path.join(ROOT, "local-asr", "models", args.name)

    sources = [
        ("encoder.onnx", args.encoder),
        ("decoder.onnx", args.decoder),
        ("joiner.onnx", args.joiner),
        ("tokens.txt", args.tokens),
    ]

    os.makedirs(args.out, exist_ok=True)
    for name in os.listdir(args.out):
        if name.startswith("data.part") or name == "manifest.json":
            os.remove(os.path.join(args.out, name))

    files, parts = [], []
    sha = hashlib.sha256()
    total = 0
    buf = bytearray()

    def flush(final=False):
        nonlocal buf
        while len(buf) >= PART or (final and buf):
            chunk, buf = bytes(buf[:PART]), buf[PART:]
            name = f"data.part{len(parts):02d}"
            with open(os.path.join(args.out, name), "wb") as o:
                o.write(chunk)
            parts.append({"name": name, "size": len(chunk)})

    for name, src in sources:
        path = os.path.join(args.model_dir, src)
        start = total
        with open(path, "rb") as f:
            while True:
                block = f.read(1 << 20)
                if not block:
                    break
                sha.update(block)
                buf += block
                total += len(block)
                flush()
        files.append({"name": name, "start": start, "end": total, "source": src})
    flush(final=True)

    manifest = {
        "model": args.id,
        "cache": "wn-local-model-" + args.id,
        "style": args.style,
        "size": total,
        "sha256": sha.hexdigest(),
        "files": files,
        "parts": parts,
    }
    with open(os.path.join(args.out, "manifest.json"), "w", encoding="utf-8") as o:
        json.dump(manifest, o, indent=1)
    print(f"{args.id}: {total / 1e6:.1f} MB in {len(parts)} parts")
    for f in files:
        print(f"  {f['name']:14s} {(f['end'] - f['start']) / 1e6:8.2f} MB  <- {f['source']}")


if __name__ == "__main__":
    sys.exit(main())

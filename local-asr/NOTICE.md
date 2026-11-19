# 第三方组件说明

这个目录里的本机语音识别引擎和模型来自开源项目，未做修改（模型只是被切成了小块以便托管）。

## 识别引擎

- `sherpa-onnx-asr.js`、`sherpa-onnx-wasm-main-asr.js`、`sherpa-onnx-wasm-main-asr.wasm`
- 来源：sherpa-onnx v1.13.7 官方发布包 `sherpa-onnx-wasm-simd-v1.13.7-zh-en-asr-zipformer.tar.bz2`
  https://github.com/k2-fsa/sherpa-onnx/releases/tag/v1.13.7
- 许可：Apache-2.0（https://github.com/k2-fsa/sherpa-onnx）

## 模型

| 目录 | 模型 | 来源 |
| --- | --- | --- |
| `models/small/` | sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16（int8 编码器与 joiner，浮点解码器） | sherpa-onnx 的 `asr-models` 发布页 |
| `models/accurate/` | sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05 | sherpa-onnx 的 `asr-models` 发布页；模型出自 X-ASR 项目（Apache-2.0，https://github.com/Gilgamesh-J/X-ASR） |

`asr-models` 发布页：https://github.com/k2-fsa/sherpa-onnx/releases/tag/asr-models

模型文件用 `tools/build_model_bundle.py` 打包：把 encoder / decoder / joiner / tokens 首尾相接后切成 24MB 的分块，
`manifest.json` 记录每个文件的位置和整体的 SHA-256。

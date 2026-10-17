# -*- coding: utf-8 -*-
r"""
程序合成一段氛围背景音乐（ambient pad），供 demo 视频使用。

完全不依赖任何第三方素材，纯正弦叠加 + 包络 + 简易混响，
所以没有任何版权问题，可放心发布。

输出：demo/bgm.wav  (44.1kHz / 16bit / 立体声 / 22 秒)

用法：
    python demo/make_bgm.py
    python demo/make_bgm.py --dur 22 --out demo\bgm.wav
"""
from __future__ import annotations

import argparse
import math
import random
import struct
import wave
from pathlib import Path

SR = 44100

# A 小调经典进行：Am - F - C - G
# 每项 = (低音频率, [和弦音])，voicing 尽量靠拢，避免大跳
CHORDS = [
    (110.00, [164.81, 220.00, 261.63, 329.63]),   # Am
    (87.31,  [130.81, 174.61, 220.00, 261.63]),   # F
    (130.81, [196.00, 261.63, 329.63, 392.00]),   # C
    (98.00,  [146.83, 196.00, 246.94, 293.66]),   # G
]

# 五声音阶高音点缀（A minor pentatonic 的高八度）
SPARKLE = [880.0, 1046.5, 1174.66, 1318.51, 1567.98]


def synth(dur: float, seed: int = 7) -> tuple[list[float], list[float], int]:
    n = int(SR * dur)
    left = [0.0] * n
    right = [0.0] * n
    rnd = random.Random(seed)

    seg = dur / len(CHORDS)
    attack = 1.3
    release = 1.5

    sin = math.sin
    pi = math.pi

    def add_tone(freq, start, length, amp, pan=0.5, harm=0.16, detune=1.0016, bright=0.0):
        """一个音：两路轻微失谐的正弦（模拟模拟合成器的漂移）叠谐波。

        纯正弦做 pad 会非常闷（能能量全在 200Hz 以下），
        所以要叠 2~5 次谐波，`bright` 控制明亮度。
        """
        i0 = int(start * SR)
        if i0 >= n:
            return
        i0 = max(0, i0)
        ns = min(int(length * SR), n - i0)
        if ns <= 4:
            return

        w0 = 2 * pi * freq / SR
        w1 = 2 * pi * freq * detune / SR
        w2 = 2 * w0
        w3 = 3 * w0
        w4 = 4 * w0
        w5 = 5 * w0
        b1 = bright * 1.00
        b2 = bright * 0.52
        b3 = bright * 0.30
        b4 = bright * 0.17
        b5 = bright * 0.10

        atk = min(int(attack * SR), ns // 3)
        rel = min(int(release * SR), ns // 3)
        atk = max(atk, 1)
        rel = max(rel, 1)

        gl = amp * (1.0 - pan) * 1.4
        gr = amp * pan * 1.4

        for i in range(ns):
            if i < atk:
                e = 0.5 - 0.5 * math.cos(pi * i / atk)
            elif i > ns - rel:
                e = 0.5 + 0.5 * math.cos(pi * (i - (ns - rel)) / rel)
            else:
                e = 1.0
            v = (sin(w0 * i) + 0.55 * sin(w1 * i)) * (1.0 + harm * sin(w2 * i))
            if bright:
                v += (b1 * sin(w0 * i) + b2 * sin(w2 * i) + b3 * sin(w3 * i)
                      + b4 * sin(w4 * i) + b5 * sin(w5 * i))
            s = v * e
            j = i0 + i
            left[j] += s * gl
            right[j] += s * gr

    # ---- 和弦铺底 ----
    for ci, (bass, tones) in enumerate(CHORDS):
        start = ci * seg
        length = seg + release          # 往后多留一点，和弦之间交叠

        # 低音：纯正弦，左右居中，稍轻
        add_tone(bass, start, length, 0.20, pan=0.5, harm=0.06, detune=1.0)

        # 和弦音：越高越轻，左右稍微分开
        for ti, f in enumerate(tones):
            amp = 0.115 * (1.0 - 0.1 * ti)
            pan = 0.32 + 0.12 * (ti % 2) + 0.04 * ti
            add_tone(f, start + 0.02 * ti, length, amp, pan=pan, bright=0.34)

        # 高八度薄薄一层，负责“空气感”，没有它会很闷
        for ti, f in enumerate(tones[-2:]):
            add_tone(f * 2, start + 0.12 + 0.05 * ti, length, 0.042,
                     pan=0.42 + 0.16 * ti, harm=0.0, bright=0.10)

    # ---- 高音点缀：稀疏、很轻，像画面切换时的闪光 ----
    for k in range(9):
        t = 2.0 + k * (dur - 4.0) / 8.0 + rnd.uniform(-0.35, 0.35)
        if t >= dur - 1.0:
            continue
        f = rnd.choice(SPARKLE)
        add_tone(f, t, 2.2, 0.052, pan=rnd.uniform(0.25, 0.75), harm=0.0)

    # ---- 简易混响：几条延迟线，交叉到对侧声道，拉开空间 ----
    taps = [(97, 0.30), (173, 0.20), (263, 0.13), (389, 0.08)]
    for ms, g in taps:
        k = int(SR * ms / 1000)
        for i in range(n - k):
            left[i + k] += right[i] * g
            right[i + k] += left[i] * g

    # ---- 总包络：1.5s 淡入 / 末尾 2.5s 淡出 ----
    fade_in = int(1.5 * SR)
    fade_out = int(2.5 * SR)
    for i in range(min(fade_in, n)):
        e = 0.5 - 0.5 * math.cos(pi * i / fade_in)
        left[i] *= e
        right[i] *= e
    # 注意索引方向：从「淡出起点」往后走，i 越大越安静。
    # 之前写成 n-1-i 会把方向弄反 —— 淡出起点被静音、末尾反而最响。
    start_out = max(0, n - fade_out)
    for i in range(n - start_out):
        e = 0.5 + 0.5 * math.cos(pi * i / fade_out)
        j = start_out + i
        left[j] *= e
        right[j] *= e

    return left, right, n


def write_wav(path: Path, left: list[float], right: list[float], n: int) -> None:
    peak = 0.0
    for i in range(n):
        peak = max(peak, abs(left[i]), abs(right[i]))
    gain = (0.72 / peak) if peak > 1e-9 else 1.0

    buf = bytearray()
    pack = struct.pack
    for i in range(n):
        l = max(-1.0, min(1.0, left[i] * gain))
        r = max(-1.0, min(1.0, right[i] * gain))
        buf += pack("<hh", int(l * 32767), int(r * 32767))

    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(bytes(buf))

    print(f"峰值归一化增益 x{gain:.2f}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dur", type=float, default=22.0)
    ap.add_argument("--out", default=str(Path(__file__).resolve().parent / "bgm.wav"))
    args = ap.parse_args()

    out = Path(args.out).resolve()
    out.parent.mkdir(parents=True, exist_ok=True)

    print(f"合成中… {args.dur:.1f}s @ {SR}Hz", flush=True)
    left, right, n = synth(args.dur)
    write_wav(out, left, right, n)

    size = out.stat().st_size / 1024 / 1024
    print(f"完成：{out}  ({size:.1f} MB)", flush=True)


if __name__ == "__main__":
    main()

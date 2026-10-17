# -*- coding: utf-8 -*-
r"""
把 demo/showcase.html 渲染成 mp4。

这不是录屏：页面在 ?rec=1 下由 window.__rec.seek(t) 决定每一帧的状态，
脚本逐帧截图后直接管道喂给 ffmpeg，所以不会丢帧、不会因为截屏时机而抖动，
帧率和时长都是精确的。

用法：
    python demo/record.py                              # 1920x1080 60fps → demo/showreel.mp4
    python demo/record.py --fps 30 --height 720        # 快速小样
    python demo/record.py --out demo/a.mp4 --crf 14    # 更高质量
    python demo/record.py --duration 5                 # 只渲前 5 秒（调试）

依赖：playwright（已装）、ffmpeg（自动查找，可用环境变量 FFMPEG 指定）
浏览器：优先用系统 Edge（channel=msedge），省得下载 Chromium
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def find_ffmpeg() -> str:
    """依次尝试：环境变量 → imageio-ffmpeg 自带 → PATH → 常见安装位置。

    优先用 imageio-ffmpeg 里的那份，因为有些盘符（比如加密盘 / 网络盘）
    里放着的 ffmpeg.exe 用 PowerShell 能跑，但 Python 的 CreateProcess 会被拒。
    """
    cands = [os.environ.get("FFMPEG")]
    try:
        import imageio_ffmpeg
        cands.append(imageio_ffmpeg.get_ffmpeg_exe())
    except Exception:
        pass
    cands += [shutil.which("ffmpeg"), r"H:\ffmpeg.exe", r"C:\ffmpeg\bin\ffmpeg.exe"]

    for cand in cands:
        if not cand:
            continue
        p = Path(cand)
        # 环境变量经常被设成 ...\bin 这样的目录，顺手补上 exe 名字
        if p.is_dir():
            p = p / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
        if p.is_file():
            return str(p)
    sys.exit("找不到 ffmpeg：请安装后加入 PATH，或设置环境变量 FFMPEG 指向可执行文件（可以是 exe，也可以是所在的 bin 目录）")


def launch_browser(pw, channel: str | None):
    """优先复用系统浏览器的内核，避免额外下载 Chromium。"""
    for ch in ([channel] if channel else ["msedge", "chrome"]):
        try:
            b = pw.chromium.launch(channel=ch)
            print(f"浏览器：{ch}", flush=True)
            return b
        except Exception:
            continue
    try:
        b = pw.chromium.launch()
        print("浏览器：playwright chromium", flush=True)
        return b
    except Exception as e:
        sys.exit(f"启动浏览器失败：{e}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--fps", type=int, default=60)
    ap.add_argument("--width", type=int, default=1920)
    ap.add_argument("--height", type=int, default=1080)
    ap.add_argument("--crf", type=int, default=16, help="越小越清晰，16~18 适合发布")
    ap.add_argument("--preset", default="slow")
    ap.add_argument("--out", default=str(ROOT / "showreel.mp4"))
    ap.add_argument("--channel", default=None, help="msedge / chrome")
    ap.add_argument("--duration", type=float, default=0, help="只渲前 N 秒（调试用）")
    ap.add_argument("--bgm", default=None, help="背景音乐（wav/mp3），用 make_bgm.py 生成")
    args = ap.parse_args()

    ffmpeg = find_ffmpeg()
    out_path = Path(args.out).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    url = (ROOT / "showcase.html").as_uri() + "?rec=1"

    from playwright.sync_api import sync_playwright

    with sync_playwright() as pw:
        browser = launch_browser(pw, args.channel)
        page = browser.new_page(
            viewport={"width": args.width, "height": args.height},
            device_scale_factor=1,
        )
        page.goto(url)
        page.wait_for_function("() => !!window.__rec", timeout=15000)
        page.evaluate("() => window.__rec.prepare()")
        page.wait_for_timeout(250)          # 等字体和首帧稳定

        total_ms = (args.duration * 1000) if args.duration else page.evaluate("() => window.__rec.duration")
        frames = int(round(total_ms / 1000 * args.fps))

        bgm = Path(args.bgm).resolve() if args.bgm else None
        if bgm and not bgm.is_file():
            sys.exit(f"找不到背景音乐：{bgm}")

        cmd = [
            ffmpeg, "-y", "-loglevel", "error",
            "-f", "image2pipe", "-vcodec", "png",
            "-framerate", str(args.fps), "-i", "-",
        ]
        if bgm:
            cmd += ["-i", str(bgm),
                    "-map", "0:v", "-map", "1:a",
                    "-c:v", "libx264", "-preset", args.preset, "-crf", str(args.crf),
                    "-pix_fmt", "yuv420p",
                    "-c:a", "aac", "-b:a", "192k", "-shortest"]
        else:
            cmd += ["-c:v", "libx264", "-preset", args.preset, "-crf", str(args.crf),
                    "-pix_fmt", "yuv420p"]
        cmd += ["-movflags", "+faststart", str(out_path)]

        print(f"ffmpeg：{ffmpeg}", flush=True)
        print(f"输出：{out_path}", flush=True)
        print(f"规格：{args.width}x{args.height} @ {args.fps}fps，共 {frames} 帧（{total_ms/1000:.1f}s）", flush=True)
        if bgm:
            print(f"音轨：{bgm.name}", flush=True)

        # stdout/stderr 必须显式接管：如果让 ffmpeg 继承 PowerShell 的管道句柄，
        # Windows 上 CreateProcess 会直接报 WinError 5（拒绝访问）。
        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        t0 = time.time()

        try:
            for i in range(frames):
                page.evaluate("(t) => window.__rec.seek(t)", i * 1000.0 / args.fps)
                proc.stdin.write(page.screenshot(type="png"))

                if i % max(1, args.fps // 2) == 0:
                    done = i / frames
                    used = time.time() - t0
                    eta = (used / done - used) if done > 0 else 0
                    print(f"  {done * 100:5.1f}%  {i}/{frames}  已用 {used:5.1f}s  剩余约 {eta:5.1f}s", flush=True)
        finally:
            try:
                proc.stdin.close()
            except Exception:
                pass
            proc.wait()
            err = b""
            try:
                if proc.stderr:
                    err = proc.stderr.read()
            except Exception:
                pass
            browser.close()

    if proc.returncode != 0:
        sys.exit(f"ffmpeg 退出码 {proc.returncode}：{err.decode('utf-8', 'replace')[:800]}")

    size = out_path.stat().st_size / 1024 / 1024
    print(f"完成：{out_path}  ({size:.1f} MB)", flush=True)


if __name__ == "__main__":
    main()

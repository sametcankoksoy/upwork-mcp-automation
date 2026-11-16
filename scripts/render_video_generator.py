import os
import sys
import time
import platform
import subprocess
import cv2
import numpy as np
from seleniumbase import SB

IS_LINUX = platform.system().lower() == "linux"

# Locate FFmpeg
if IS_LINUX:
    FFMPEG_EXE = "ffmpeg"
else:
    FFMPEG_EXE = r"C:\Users\root\AppData\Local\Programs\Python\Python312\Lib\site-packages\imageio_ffmpeg\binaries\ffmpeg-win-x86_64-v7.1.exe"

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS_DIR = os.path.join(PROJECT_DIR, "assets")
PUBLIC_VIDEOS_DIR = os.path.join(PROJECT_DIR, "public", "videos")
os.makedirs(PUBLIC_VIDEOS_DIR, exist_ok=True)

SCENE1_WEBCAM = os.path.join(ASSETS_DIR, "shared_scene1_webcam.mp4")
SCENE2_MASTER = os.path.join(ASSETS_DIR, "shared_scene2.mp4")
MASK_PATH = os.path.join(ASSETS_DIR, "bubble_mask_1728x1080.png")

TRANSITION_SEC = 8.15
SPEED = 1.15
FPS = 25
MAX_SCROLL_Y = 380

def generate_proposal_video(url, out_video_path, proxy=None):
    t0 = time.time()
    width, height = 1728, 1080
    total_frames = int(round(TRANSITION_SEC * FPS)) # 204 frames
    temp_bg = os.path.join(ASSETS_DIR, f"temp_bg_{int(time.time())}.mp4")
    temp_s1 = os.path.join(ASSETS_DIR, f"temp_s1_{int(time.time())}.mp4")
    
    print(f"Starting browser session (Linux={IS_LINUX}, Proxy={bool(proxy)})...")
    sb_kwargs = {
        "uc": True,
        "test": False,
        "headless": False,
        "xvfb": IS_LINUX
    }
    if proxy:
        sb_kwargs["proxy"] = proxy
        
    with SB(**sb_kwargs) as sb:
        sb.set_window_size(1728, 1080)
        print(f"Opening URL: {url}...")
        sb.uc_open_with_reconnect(url, reconnect_time=2)
        time.sleep(2)
        
        # Clean cookie/dark filters and sticky banner popups
        try:
            sb.execute_script("""
                const ids = ['onetrust-consent-sdk', 'onetrust-pc-dark-filter', 'onetrust-banner-sdk'];
                ids.forEach(id => {
                    const el = document.getElementById(id);
                    if (el) el.remove();
                });
                const darks = document.querySelectorAll('.onetrust-pc-dark-filter');
                darks.forEach(d => d.remove());
            """)
        except Exception:
            pass
            
        cmd = [
            FFMPEG_EXE, "-y",
            "-f", "image2pipe", "-vcodec", "png", "-r", str(FPS),
            "-i", "pipe:0",
            "-vf", f"scale={width}:{height}",
            "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18",
            "-pix_fmt", "yuv420p",
            temp_bg
        ]
        proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        # Phase 1: 0 to 1.0s (25 frames) Top (y=0)
        p1_frames = int(1.0 * FPS)
        sb.execute_script("window.scrollTo(0, 0);")
        top_frame = sb.driver.get_screenshot_as_png()
        for _ in range(p1_frames):
            proc.stdin.write(top_frame)
            
        # Phase 2: 1.0 to 4.2s (80 frames) 100% UNIQUE FRAMES Scroll down to job text (0 -> MAX_SCROLL_Y)
        p2_frames = int(3.2 * FPS)
        for i in range(p2_frames):
            prog = (i + 1) / float(p2_frames)
            ease = 3 * (prog ** 2) - 2 * (prog ** 3)
            y = int(ease * MAX_SCROLL_Y)
            sb.execute_script(f"window.scrollTo(0, {y});")
            f = sb.driver.get_screenshot_as_png()
            proc.stdin.write(f)
            
        # Phase 3: 4.2 to 5.0s (20 frames) Hold at text
        p3_frames = int(0.8 * FPS)
        bottom_frame = sb.driver.get_screenshot_as_png()
        for _ in range(p3_frames):
            proc.stdin.write(bottom_frame)
            
        # Phase 4: 5.0 to 6.6s (40 frames) 100% UNIQUE FRAMES 2x Fast scroll up (MAX_SCROLL_Y -> 0)
        p4_frames = int(1.6 * FPS)
        for i in range(p4_frames):
            prog = (i + 1) / float(p4_frames)
            ease = 3 * (prog ** 2) - 2 * (prog ** 3)
            y = int((1.0 - ease) * MAX_SCROLL_Y)
            sb.execute_script(f"window.scrollTo(0, {y});")
            f = sb.driver.get_screenshot_as_png()
            proc.stdin.write(f)
            
        # Phase 5: 6.6 to 8.15s (remaining frames) Hold at top (y=0)
        sb.execute_script("window.scrollTo(0, 0);")
        final_top = sb.driver.get_screenshot_as_png()
        written = p1_frames + p2_frames + p3_frames + p4_frames
        p5_frames = total_frames - written
        for _ in range(p5_frames):
            proc.stdin.write(final_top)
            
        proc.stdin.close()
        proc.wait()
        
    print("Background recording complete. Compositing Scene 1...")
    # Render Scene 1: background + self-contained webcam + alpha mask
    filter_s1 = (
        "[0:v]scale=1728:1080,setsar=1[bg];"
        "[1:v][2:v]alphamerge[cam];"
        "[bg][cam]overlay=0:0[v]"
    )
    cmd_s1 = [
        FFMPEG_EXE, "-y",
        "-i", temp_bg,
        "-i", SCENE1_WEBCAM,
        "-loop", "1", "-t", str(TRANSITION_SEC), "-i", MASK_PATH,
        "-filter_complex", filter_s1,
        "-map", "[v]",
        "-map", "1:a",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        temp_s1
    ]
    subprocess.run(cmd_s1, check=True)
    
    print("Con-catenating Scene 1 & Scene 2 with 1.15x speed...")
    filter_concat = (
        f"[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[cv][ca];"
        f"[cv]setpts=PTS/{SPEED}[v];"
        f"[ca]atempo={SPEED}[a]"
    )
    cmd_concat = [
        FFMPEG_EXE, "-y",
        "-i", temp_s1,
        "-i", SCENE2_MASTER,
        "-filter_complex", filter_concat,
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        out_video_path
    ]
    subprocess.run(cmd_concat, check=True)
    
    # Cleanup temps
    for p in [temp_bg, temp_s1]:
        if os.path.exists(p):
            try: os.remove(p)
            except Exception: pass
            
    dur_sec = time.time() - t0
    file_size_mb = os.path.getsize(out_video_path) / (1024 * 1024)
    print(f"Video generated in {dur_sec:.1f}s | Size: {file_size_mb:.2f} MB | Saved to: {out_video_path}")
    return {
        "success": True,
        "duration_sec": dur_sec,
        "size_mb": file_size_mb,
        "output_path": out_video_path
    }

if __name__ == "__main__":
    test_url = sys.argv[1] if len(sys.argv) > 1 else "https://www.upwork.com/jobs/~022121736800735949407"
    out_file = sys.argv[2] if len(sys.argv) > 2 else os.path.join(PUBLIC_VIDEOS_DIR, "test_render_engine.mp4")
    res = generate_proposal_video(test_url, out_file)
    print("Result:", res)

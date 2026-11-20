import os
import sys
import re
import time
import platform
import subprocess
import cv2
import numpy as np
from seleniumbase import SB

IS_LINUX = platform.system().lower() == "linux"

# Locate FFmpeg dynamically
try:
    import imageio_ffmpeg
    FFMPEG_EXE = imageio_ffmpeg.get_ffmpeg_exe()
except Exception:
    FFMPEG_EXE = "ffmpeg"

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ASSETS_DIR = os.path.join(PROJECT_DIR, "assets")
PUBLIC_VIDEOS_DIR = os.path.join(PROJECT_DIR, "public", "videos")
PUBLIC_THUMBS_DIR = os.path.join(PROJECT_DIR, "public", "thumbnails")
os.makedirs(PUBLIC_VIDEOS_DIR, exist_ok=True)
os.makedirs(PUBLIC_THUMBS_DIR, exist_ok=True)

SCENE1_WEBCAM = os.path.join(ASSETS_DIR, "shared_scene1_webcam.mp4")
SCENE2_MASTER = os.path.join(ASSETS_DIR, "shared_scene2.mp4")
MASK_PATH = os.path.join(ASSETS_DIR, "bubble_mask_1728x1080.png")

TRANSITION_SEC = 8.15
SPEED = 1.15
FPS = 25
MAX_SCROLL_Y = 520

def save_loom_thumbnail(video_path, thumb_path):
    """Extract a clean early frame from the video for link previews."""
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"Could not open video for thumbnail: {video_path}")

    cap.set(cv2.CAP_PROP_POS_FRAMES, 20)
    ret, frame = cap.read()
    if not ret or frame is None:
        cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        ret, frame = cap.read()
    cap.release()

    if not ret or frame is None:
        raise RuntimeError(f"Failed to read frame from video: {video_path}")

    os.makedirs(os.path.dirname(thumb_path), exist_ok=True)
    ok = cv2.imwrite(thumb_path, frame, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    if not ok:
        raise RuntimeError(f"Failed to write thumbnail: {thumb_path}")
    return thumb_path

def generate_proposal_video(url, out_video_path, proxy=None, strict_under_5=False):
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

        page_src = (sb.get_page_source() or "").lower()
        if "this job is a private listing" in page_src or "job is no longer available" in page_src:
            raise RuntimeError("PRIVATE_OR_CLOSED_JOB")

        if strict_under_5:
            body_text = sb.get_text("body") or ""
            m_prop = re.search(r"Proposals[\s:\r\n]+(10 to 15|15 to 20|20 to 50|50\+)", body_text, re.I)
            if m_prop:
                raise RuntimeError(f"PROPOSALS_OVER_10:{m_prop.group(1)}")
        
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
        
        # Phase 1: 0 to 2.4s (Hold at top y=0 while saying "Hey how's it going?")
        p1_frames = int(2.4 * FPS)
        sb.execute_script("window.scrollTo(0, 0);")
        top_frame = sb.driver.get_screenshot_as_png()
        for _ in range(p1_frames):
            proc.stdin.write(top_frame)
            
        # Phase 2: 0.3s lightning-fast flick down (0 -> MAX_SCROLL_Y)
        p2_frames = max(1, int(0.3 * FPS)) # 7-8 frames
        for i in range(p2_frames):
            prog = (i + 1) / float(p2_frames)
            ease = 3 * (prog ** 2) - 2 * (prog ** 3)
            y = int(ease * MAX_SCROLL_Y)
            sb.execute_script(f"window.scrollTo(0, {y});")
            f = sb.driver.get_screenshot_as_png()
            proc.stdin.write(f)
            
        # Phase 3: 0.35s quick glance at job description
        p3_frames = max(1, int(0.35 * FPS)) # ~9 frames
        bottom_frame = sb.driver.get_screenshot_as_png()
        for _ in range(p3_frames):
            proc.stdin.write(bottom_frame)
            
        # Phase 4: 0.2s lightning-fast flick back up to top (MAX_SCROLL_Y -> 0)
        p4_frames = max(1, int(0.2 * FPS)) # 5 frames
        for i in range(p4_frames):
            prog = (i + 1) / float(p4_frames)
            ease = 3 * (prog ** 2) - 2 * (prog ** 3)
            y = int((1.0 - ease) * MAX_SCROLL_Y)
            sb.execute_script(f"window.scrollTo(0, {y});")
            f = sb.driver.get_screenshot_as_png()
            proc.stdin.write(f)
            
        # Phase 5: Hold at top y=0 for the rest of Scene 1
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
    
    print("Con-catenating Scene 1 & Scene 2 with 1.15x speed & compact ASS subtitles...")
    ass_path = os.path.abspath(os.path.join(ASSETS_DIR, "subtitles_master.ass")).replace("\\", "/")
    escaped_ass = ass_path.replace(":", r"\:")
    
    filter_concat = (
        f"[0:v][0:a][1:v][1:a]concat=n=2:v=1:a=1[cv][ca];"
        f"[cv]setpts=PTS/{SPEED},ass='{escaped_ass}'[v];"
        f"[ca]atempo={SPEED}[a]"
    )
    cmd_concat = [
        FFMPEG_EXE, "-y",
        "-i", temp_s1,
        "-i", SCENE2_MASTER,
        "-filter_complex", filter_concat,
        "-map", "[v]",
        "-map", "[a]",
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "22", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-movflags", "+faststart",
        out_video_path
    ]
    subprocess.run(cmd_concat, check=True)
    
    # Cleanup temps
    for p in [temp_bg, temp_s1]:
        if os.path.exists(p):
            try: os.remove(p)
            except Exception: pass

    base_id = os.path.splitext(os.path.basename(out_video_path))[0]
    thumb_path = os.path.join(PUBLIC_THUMBS_DIR, f"{base_id}.jpg")
    try:
        save_loom_thumbnail(out_video_path, thumb_path)
    except Exception as thumb_err:
        print(f"Warning: Could not generate thumbnail: {thumb_err}")

    dur_sec = time.time() - t0
    file_size_mb = os.path.getsize(out_video_path) / (1024 * 1024)
    print(f"Video generated in {dur_sec:.1f}s | Size: {file_size_mb:.2f} MB | Saved to: {out_video_path}")
    return {
        "success": True,
        "duration_sec": dur_sec,
        "size_mb": file_size_mb,
        "output_path": out_video_path,
        "thumbnail_path": thumb_path
    }

if __name__ == "__main__":
    strict_flag = "--strict-under-5" in sys.argv
    pos_args = [a for a in sys.argv[1:] if not a.startswith("--")]
    test_url = pos_args[0] if len(pos_args) > 0 else "https://www.upwork.com/jobs/~022121736800735949407"
    out_file = pos_args[1] if len(pos_args) > 1 else os.path.join(PUBLIC_VIDEOS_DIR, "test_render_engine.mp4")
    res = generate_proposal_video(test_url, out_file, strict_under_5=strict_flag)
    print("Result:", res)

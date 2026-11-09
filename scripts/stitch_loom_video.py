"""
High-Definition Human-Physics Loom Generator
- 1080p Full HD Razor-Sharp Resolution (CRF 17, 8Mbps bitrate)
- Realistic Human Reading & Scrolling Curve (Reading pauses + smooth cubic easing + micro-jitters)
- Polished Loom Circular Webcam Bubble with drop-shadow and anti-aliased border
"""
import os
import sys
import time
import json
import argparse
import subprocess
import numpy as np
from PIL import Image, ImageDraw
import imageio
import imageio_ffmpeg

def get_job_from_db(job_id):
    try:
        import sqlite3
        db_path = os.path.join(os.path.dirname(__file__), '..', 'data', 'upwork_analytics.sqlite')
        if not os.path.exists(db_path):
            return None
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cur = conn.cursor()
        cur.execute("SELECT * FROM jobs WHERE job_id = ? OR job_id LIKE ? LIMIT 1", (job_id, f"%{job_id}%"))
        row = cur.fetchone()
        conn.close()
        return dict(row) if row else None
    except Exception as e:
        print(f"DB lookup warning: {e}", file=sys.stderr)
        return None

def get_video_duration(video_path):
    try:
        reader = imageio.get_reader(video_path)
        meta = reader.get_meta_data()
        reader.close()
        return float(meta.get('duration', 15.0))
    except Exception as e:
        return 15.0

def snappy_human_scroll(f, total_frames=300, max_scroll=850):
    """
    Simulates real fast human mouse-wheel flicks:
    - 0 to 1.2s: Stays at top looking at title & budget
    - 1.2s to 4.0s (56 frames = 2.8s): Downward mouse wheel flicks down to bottom
    - 4.0s to 7.0s (60 frames = 3.0s): Reading & inspecting client stats & scope at bottom
    - 7.0s to 8.4s (26 frames = 1.3s): 2X FASTER UPWARD FLICK! (whips back up in half the time)
    - 8.4s to 15.0s: Rest cleanly at top hero section while delivering pitch
    """
    if max_scroll <= 10:
        return 0

    scale = max_scroll / 850.0

    # Phase 1: 0 - 24 frames (0 - 1.2s) -> Looking at top
    if f < 24:
        return 0

    # Phase 2: 24 - 80 frames (1.2s - 4.0s) -> Downward scroll (2.8 seconds)
    elif f < 80:
        # Flick 1: 24..44 -> 0 to 420px
        if f < 44:
            p = (f - 24) / 20.0
            ease = 1.0 - (1.0 - p)**3
            return int(ease * 420 * scale)
        # Micro pause: 44..50
        elif f < 50:
            return int(420 * scale)
        # Flick 2: 50..70 -> 420 to 760px
        elif f < 70:
            p = (f - 50) / 20.0
            ease = 1.0 - (1.0 - p)**3
            return int((420 + ease * 340) * scale)
        # Micro pause: 70..74
        elif f < 74:
            return int(760 * scale)
        # Flick 3: 74..80 -> 760 to max_scroll
        else:
            p = (f - 74) / 6.0
            ease = 1.0 - (1.0 - p)**3
            return int((760 + ease * 90) * scale)

    # Phase 3: 80 - 140 frames (4.0s - 7.0s) -> Reading bottom client stats (3.0 seconds)
    elif f < 140:
        micro = np.sin((f - 80) * 0.15) * 2.0
        return int(max_scroll - abs(micro))

    # Phase 4: 140 - 166 frames (7.0s - 8.3s) -> 2X FASTER UPWARD WHIP (takes only 1.3 seconds!)
    elif f < 166:
        p = (f - 140) / 26.0
        # Swift upward whip with natural damping
        ease = 1.0 - (1.0 - p)**3
        return int(max_scroll * (1.0 - ease))

    # Phase 5: 166 - 300 frames (8.3s - 15.0s) -> Rest cleanly at top for pitch
    else:
        return 0

def generate_local_job_html(job):
    """High-fidelity, crisp 1080p Upwork Job Post HTML page with dark mode and crisp fonts."""
    title = job.get('title', 'Senior AI & Automation Engineer')
    desc = job.get('description', 'Looking for an experienced engineer to build automation workflows.')
    budget = f"${job.get('budget', 0):,}" if job.get('budget', 0) > 0 else f"${job.get('hourly_min', 25)}-${job.get('hourly_max', 50)}/hr"
    country = job.get('client_country', 'United States')
    hire_rate = f"{job.get('client_hire_rate', 80)}%"
    spent = f"${job.get('client_total_spent', 15000):,.0f}"

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>{title} - Upwork</title>
  <style>
    * {{ box-sizing: border-box; -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale; }}
    body {{
      margin: 0; padding: 0; background: #0c101c; color: #f1f5f9;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }}
    .nav {{
      background: #111827; border-bottom: 1px solid #1f293d; padding: 18px 64px;
      display: flex; align-items: center; justify-content: space-between;
    }}
    .logo {{ color: #10b981; font-weight: 800; font-size: 24px; letter-spacing: -0.5px; }}
    .container {{ max-width: 1080px; margin: 32px auto; padding: 0 32px; padding-bottom: 50px; }}
    .job-card {{
      background: #151d2f; border: 1px solid #233047; border-radius: 18px; padding: 40px;
      box-shadow: 0 20px 40px -10px rgba(0,0,0,0.5);
    }}
    .badge {{
      display: inline-block; background: rgba(16, 185, 129, 0.15); color: #10b981;
      border: 1px solid rgba(16, 185, 129, 0.3); padding: 6px 14px; border-radius: 8px;
      font-size: 13px; font-weight: 700; margin-bottom: 18px;
    }}
    h1 {{ font-size: 28px; color: #ffffff; margin: 0 0 18px 0; line-height: 1.35; font-weight: 800; }}
    .meta-bar {{
      display: flex; gap: 32px; padding-bottom: 22px; border-bottom: 1px solid #233047;
      color: #94a3b8; font-size: 15px; margin-bottom: 24px;
    }}
    .meta-val {{ color: #ffffff; font-weight: 700; }}
    .description {{ font-size: 16px; line-height: 1.85; color: #cbd5e1; white-space: pre-wrap; font-weight: 400; }}
    .client-sidebar {{
      margin-top: 36px; padding: 24px; background: #0f1523; border-radius: 14px;
      border: 1px solid #1e293b; display: grid; grid-template-columns: repeat(3, 1fr); gap: 20px;
    }}
    .client-stat-title {{ font-size: 12px; color: #64748b; text-transform: uppercase; font-weight: 700; letter-spacing: 0.5px; }}
    .client-stat-val {{ font-size: 18px; font-weight: 800; color: #ffffff; margin-top: 5px; }}
  </style>
</head>
<body>
  <div class="nav">
    <div class="logo">upwork</div>
    <div style="font-size: 14px; color: #94a3b8; font-weight: 500;">Job ID: ~02{job.get('job_id', '')}</div>
  </div>
  <div class="container">
    <div class="job-card">
      <div class="badge">Open Proposal Target</div>
      <h1>{title}</h1>
      <div class="meta-bar">
        <div>Budget: <span class="meta-val">{budget}</span></div>
        <div>Client Location: <span class="meta-val">{country}</span></div>
        <div>Client Hire Rate: <span class="meta-val" style="color: #10b981;">{hire_rate}</span></div>
      </div>
      <div class="description">{desc}</div>
      <div class="client-sidebar">
        <div>
          <div class="client-stat-title">Client Total Spent</div>
          <div class="client-stat-val">{spent}</div>
        </div>
        <div>
          <div class="client-stat-title">Client Hire Rate</div>
          <div class="client-stat-val" style="color: #10b981;">{hire_rate}</div>
        </div>
        <div>
          <div class="client-stat-title">Payment Verification</div>
          <div class="client-stat-val" style="color: #38bdf8;">Verified</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>"""
    return html

def record_job_background(job, output_bg_path, duration_secs, target_url=None):
    """
    Renders 1080p high-definition browser frames using human scroll physics.
    """
    width, height = 1920, 1080
    fps = 20
    total_frames = int(duration_secs * fps)
    frames_dir = os.path.join("public", "videos", f"temp_frames_{job.get('job_id', 'job')}")
    os.makedirs(frames_dir, exist_ok=True)

    driver = None
    try:
        from seleniumbase import Driver
        print(f"Launching SeleniumBase 1080p ({width}x{height}) with Human Scroll Physics for {duration_secs:.1f}s...")
        driver = Driver(uc=True, headless=True, window_size=f"{width},{height}")

        loaded_live = False
        if target_url and target_url.startswith('http'):
            try:
                driver.get(target_url)
                time.sleep(2)
                if "upwork.com" in driver.current_url and driver.title:
                    loaded_live = True
            except Exception as ex:
                print(f"Live URL load notice: {ex}", file=sys.stderr)

        if not loaded_live:
            temp_html_path = os.path.abspath("temp_job_render.html")
            with open(temp_html_path, "w", encoding="utf-8") as f:
                f.write(generate_local_job_html(job))
            driver.get(f"file:///{temp_html_path}")
            time.sleep(1)

        # Calculate EXACT text-based scroll depth:
        # Scroll actively through the entire job post without falling into void whitespace
        scroll_calc_js = """
        const card = document.querySelector('.job-card') || document.querySelector('main') || document.body;
        if (!card) return 600;
        const cardTop = card.offsetTop;
        const cardBottom = cardTop + card.offsetHeight;
        const winH = window.innerHeight;
        const needed = cardBottom - winH + 60;
        return Math.max(500, Math.min(needed, 850));
        """
        max_scroll = int(driver.execute_script(scroll_calc_js))
        print(f"Calculated text-bounded scroll depth: {max_scroll}px across {total_frames} frames")

        # Capture frames following fast, snappy human mouse-wheel flicks
        for f_idx in range(total_frames):
            target_y = int(snappy_human_scroll(f_idx, total_frames, max_scroll))
            
            # Instant position jump to target_y (smoothest per-frame capture)
            driver.execute_script(f"window.scrollTo(0, {target_y});")
            
            frame_path = os.path.join(frames_dir, f"frame_{f_idx:04d}.png")
            driver.save_screenshot(frame_path)

        if os.path.exists("temp_job_render.html"):
            try:
                os.remove("temp_job_render.html")
            except:
                pass

    finally:
        if driver:
            try:
                driver.quit()
            except:
                pass

    # Use FFmpeg to compile frames into high-bitrate 1080p video (CRF 16, 10Mbps)
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    compile_cmd = [
        ffmpeg_exe, "-y",
        "-framerate", str(fps),
        "-i", os.path.join(frames_dir, "frame_%04d.png"),
        "-c:v", "libx264",
        "-crf", "16",
        "-b:v", "10M",
        "-preset", "fast",
        "-pix_fmt", "yuv420p",
        output_bg_path
    ]
    print(f"Compiling 1080p background video with FFmpeg...")
    subprocess.run(compile_cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True)

    # Clean up frames
    try:
        import shutil
        shutil.rmtree(frames_dir)
    except:
        pass

    print(f"High-Def 1080p background video saved to: {output_bg_path}")
    return output_bg_path

def composite_webcam_over_job(bg_video_path, webcam_video_path, final_output_path):
    """
    Overlays high-res circular webcam bubble in bottom-left at 1080p.
    Includes anti-aliasing and crisp bitrate (CRF 18).
    """
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    
    # 1080p layout: 320x320 crisp circular webcam bubble with smooth edges at (50, H - 370)
    filter_str = (
        "[1:v]scale=320:320,format=yuva420p,"
        "geq=lum='p(X,Y)':a='if(gt(hypot(X-W/2,Y-H/2),W/2-4),0,255)'[bubble];"
        "[0:v][bubble]overlay=50:main_h-overlay_h-50:shortest=1[outv]"
    )

    cmd = [
        ffmpeg_exe, "-y",
        "-i", bg_video_path,
        "-i", webcam_video_path,
        "-filter_complex", filter_str,
        "-map", "[outv]",
        "-map", "1:a?",
        "-c:v", "libx264",
        "-crf", "18",
        "-b:v", "12M",
        "-maxrate", "16M",
        "-bufsize", "24M",
        "-preset", "fast",
        "-pix_fmt", "yuv420p",
        "-c:a", "aac",
        "-b:a", "192k",
        final_output_path
    ]

    print(f"Rendering crystal-clear 1080p composite -> {final_output_path}...")
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        print(f"FFmpeg composite error: {res.stderr}", file=sys.stderr)
        raise RuntimeError(f"FFmpeg failed: {res.stderr}")

    print(f"SUCCESS: 1080p Full HD Loom video created at: {final_output_path}")

def main():
    parser = argparse.ArgumentParser(description="Create High-Def Loom with human scroll physics.")
    parser.add_argument("--job-id", required=True, help="Upwork Job ID")
    parser.add_argument("--url", help="Job URL (optional)")
    parser.add_argument("--webcam", default="assets/master_webcam.mp4", help="Path to static master webcam video")
    parser.add_argument("--output-dir", default="public/videos", help="Directory to save final video")
    args = parser.parse_args()

    os.makedirs(args.output_dir, exist_ok=True)
    os.makedirs("assets", exist_ok=True)

    job_id = args.job_id
    job = get_job_from_db(job_id) or {
        "job_id": job_id,
        "title": "Senior AI & Automation Engineer",
        "description": "Looking for an expert to automate end-to-end data workflows.",
        "budget": 2000,
        "client_country": "United States",
        "client_hire_rate": 90,
        "client_total_spent": 85000
    }

    job_url = args.url or f"https://www.upwork.com/jobs/~02{job_id}"
    webcam_path = args.webcam

    if not os.path.exists(webcam_path):
        print(f"Webcam file not found at {webcam_path}, generating placeholder...")
        subprocess.run([sys.executable, "scripts/generate_placeholder_webcam.py"], check=True)

    duration = get_video_duration(webcam_path)
    print(f"Webcam video duration: {duration:.1f}s")

    temp_bg = os.path.join(args.output_dir, f"temp_bg_{job_id}.mp4")
    record_job_background(job, temp_bg, duration, job_url)

    final_output = os.path.join(args.output_dir, f"{job_id}.mp4")
    composite_webcam_over_job(temp_bg, webcam_path, final_output)

    if os.path.exists(temp_bg):
        try:
            os.remove(temp_bg)
        except:
            pass

    proposal_text = (
        f"Hey there,\n\n"
        f"I saw your post regarding '{job.get('title', 'your project')}'. "
        f"Instead of a generic copy-pasted proposal, I pulled up your job post on my screen and recorded a quick Loom walking through it:\n\n"
        f"👉 https://upwork-mcp-automation.onrender.com/loom/{job_id}\n\n"
        f"Let me know what you think after watching, and we can discuss next steps!\n\n"
        f"Best,\n"
        f"Samet Can Koksoy"
    )

    result = {
        "success": True,
        "job_id": job_id,
        "video_file": final_output,
        "video_url": f"/videos/{job_id}.mp4",
        "loom_page_url": f"/loom/{job_id}",
        "proposal_text": proposal_text
    }

    print("\n=== LOOM GENERATION RESULT ===")
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main()

"""
Automated Loom Engine: Client Job Post in Background + Static User Webcam in Bottom-Left
1. Master video: assets/master_webcam.mp4 (User talking head recording, with audio)
2. Target job: Client's Upwork job post opened via SeleniumBase (or local high-fidelity HTML render)
3. Background: Fullscreen recording of the client's job post scrolling smoothly for the duration of the master video
4. Overlay: User's circular webcam bubble in the bottom-left corner with audio
5. Output: public/videos/{job_id}.mp4
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
        print(f"Could not read duration: {e}", file=sys.stderr)
        return 15.0

def generate_local_job_html(job):
    """High-fidelity Upwork Job Post HTML page to record."""
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
    body {{
      margin: 0; padding: 0; background: #0b0f19; color: #e2e8f0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }}
    .nav {{
      background: #111827; border-bottom: 1px solid #1f2937; padding: 16px 48px;
      display: flex; align-items: center; justify-content: space-between;
    }}
    .logo {{ color: #10b981; font-weight: 800; font-size: 22px; letter-spacing: -0.5px; }}
    .container {{ max-width: 980px; margin: 36px auto; padding: 0 24px; padding-bottom: 160px; }}
    .job-card {{
      background: #161f30; border: 1px solid #243247; border-radius: 16px; padding: 40px;
      box-shadow: 0 10px 25px -5px rgba(0,0,0,0.4);
    }}
    .badge {{
      display: inline-block; background: rgba(16, 185, 129, 0.15); color: #10b981;
      padding: 5px 12px; border-radius: 6px; font-size: 13px; font-weight: 600; margin-bottom: 16px;
    }}
    h1 {{ font-size: 26px; color: #ffffff; margin: 0 0 18px 0; line-height: 1.35; font-weight: 700; }}
    .meta-bar {{
      display: flex; gap: 28px; padding-bottom: 24px; border-bottom: 1px solid #243247;
      color: #94a3b8; font-size: 15px; margin-bottom: 24px;
    }}
    .meta-val {{ color: #ffffff; font-weight: 700; }}
    .description {{ font-size: 15px; line-height: 1.8; color: #cbd5e1; white-space: pre-wrap; }}
    .client-sidebar {{
      margin-top: 36px; padding: 24px; background: #0f1624; border-radius: 12px;
      border: 1px solid #1f293d; display: flex; justify-content: space-between; align-items: center;
    }}
    .client-stat-title {{ font-size: 12px; color: #64748b; text-transform: uppercase; font-weight: 600; }}
    .client-stat-val {{ font-size: 16px; font-weight: 700; color: #e2e8f0; margin-top: 5px; }}
  </style>
</head>
<body>
  <div class="nav">
    <div class="logo">upwork</div>
    <div style="font-size: 13px; color: #94a3b8;">Job ID: ~02{job.get('job_id', '')}</div>
  </div>
  <div class="container">
    <div class="job-card">
      <div class="badge">Open Proposal Target</div>
      <h1>{title}</h1>
      <div class="meta-bar">
        <div>Budget: <span class="meta-val">{budget}</span></div>
        <div>Client Location: <span class="meta-val">{country}</span></div>
        <div>Hire Rate: <span class="meta-val" style="color: #10b981;">{hire_rate}</span></div>
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
    """Records the job post in the background scrolling naturally for duration_secs."""
    width, height = 1280, 720
    fps = 15
    total_frames = int(duration_secs * fps)
    frames = []

    driver = None
    try:
        from seleniumbase import Driver
        print(f"Launching SeleniumBase to record client's job post for {duration_secs:.1f}s ({total_frames} frames)...")
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

        # Smooth scrolling: slow down scrolling so it looks like reading
        scroll_step = max(2, int(600 / total_frames))
        for f_idx in range(total_frames):
            if f_idx % 2 == 0:
                driver.execute_script(f"window.scrollBy({{top: {scroll_step}, behavior: 'instant'}});")
            png_bytes = driver.get_screenshot_as_png()
            import io
            img = Image.open(io.BytesIO(png_bytes)).resize((width, height))
            frames.append(np.array(img.convert('RGB')))

        if os.path.exists("temp_job_render.html"):
            try:
                os.remove("temp_job_render.html")
            except:
                pass

    except Exception as e:
        print(f"SeleniumBase error: {e}", file=sys.stderr)
        # Fallback synthetic frame renderer
        title = job.get('title', 'Upwork Project')
        for f_idx in range(total_frames):
            img = Image.new('RGB', (width, height), color=(15, 20, 34))
            draw = ImageDraw.Draw(img)
            draw.rectangle([0, 0, width, 60], fill=(22, 28, 48))
            draw.text((40, 20), "upwork  |  Job Post Preview", fill=(16, 185, 129))
            
            scroll_offset = f_idx * 3
            card_y = 100 - scroll_offset
            draw.rounded_rectangle([40, card_y, width - 40, card_y + 900], radius=12, fill=(22, 28, 48), outline=(31, 41, 61), width=2)
            draw.text((60, card_y + 30), f"TARGET JOB: {title}", fill=(255, 255, 255))
            draw.text((60, card_y + 70), "Client: Payment Verified  |  Budget: High Priority", fill=(56, 189, 248))
            frames.append(np.array(img))

    finally:
        if driver:
            try:
                driver.quit()
            except:
                pass

    imageio.mimsave(output_bg_path, frames, fps=fps, codec='libx264')
    print(f"Saved background job post video ({len(frames)} frames) to: {output_bg_path}")
    return output_bg_path

def composite_webcam_over_job(bg_video_path, webcam_video_path, final_output_path):
    """
    Overlays user's webcam video as a circular bubble in the bottom-left corner over the job post.
    Uses FFmpeg with circular alpha mask and keeps webcam audio.
    """
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    
    # 240x240 circular crop with green border overlay
    # geq lum: keeps circular pixels, a: transparent outside radius
    filter_str = (
        "[1:v]scale=240:240,format=yuva420p,"
        "geq=lum='p(X,Y)':a='if(gt(hypot(X-W/2,Y-H/2),W/2-3),0,255)'[bubble];"
        "[0:v][bubble]overlay=35:main_h-overlay_h-35:shortest=1[outv]"
    )

    cmd = [
        ffmpeg_exe, "-y",
        "-i", bg_video_path,
        "-i", webcam_video_path,
        "-filter_complex", filter_str,
        "-map", "[outv]",
        "-map", "1:a?",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-c:a", "aac",
        final_output_path
    ]

    print(f"Compositing circular webcam bubble onto job background -> {final_output_path}...")
    res = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if res.returncode != 0:
        print(f"FFmpeg composite error: {res.stderr}", file=sys.stderr)
        raise RuntimeError(f"FFmpeg failed: {res.stderr}")

    print(f"SUCCESS: Created final Loom video at: {final_output_path}")

def main():
    parser = argparse.ArgumentParser(description="Create Loom with job post background and static webcam bubble in bottom-left.")
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

    # Verify or generate master webcam placeholder
    if not os.path.exists(webcam_path):
        print(f"Webcam file not found at {webcam_path}, generating placeholder...")
        subprocess.run([sys.executable, "scripts/generate_placeholder_webcam.py"], check=True)

    # 1. Get duration of the user's master webcam video
    duration = get_video_duration(webcam_path)
    print(f"Master webcam video duration: {duration:.1f} seconds")

    # 2. Record client's job post for that exact duration
    temp_bg = os.path.join(args.output_dir, f"temp_bg_{job_id}.mp4")
    record_job_background(job, temp_bg, duration, job_url)

    # 3. Composite webcam in bottom-left over the job post
    final_output = os.path.join(args.output_dir, f"{job_id}.mp4")
    composite_webcam_over_job(temp_bg, webcam_path, final_output)

    # Clean up temp background
    if os.path.exists(temp_bg):
        try:
            os.remove(temp_bg)
        except:
            pass

    # 4. Generate proposal hook text
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

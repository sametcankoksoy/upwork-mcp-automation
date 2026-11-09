"""
Automated Upwork Loom Generator (SeleniumBase + MoviePy / ImageIO)
1. Takes a job_id or URL
2. Opens the job page with SeleniumBase (or renders local job view from SQLite if blocked)
3. Smoothly scrolls down the job post and captures 5-6s screen recording
4. Stitches it seamlessly with assets/master_profile.mp4
5. Saves to public/videos/{job_id}.mp4
"""
import os
import sys
import time
import json
import argparse
import numpy as np
from PIL import Image, ImageDraw

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

def generate_local_job_html(job):
    """Fallback high-fidelity Upwork Job Post HTML page to record if live URL is gated."""
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
      background: #111827; border-bottom: 1px solid #1f2937; padding: 14px 48px;
      display: flex; align-items: center; justify-content: space-between;
    }}
    .logo {{ color: #10b981; font-weight: 800; font-size: 20px; letter-spacing: -0.5px; }}
    .container {{ max-width: 980px; margin: 32px auto; padding: 0 24px; }}
    .job-card {{
      background: #161f30; border: 1px solid #243247; border-radius: 16px; padding: 36px;
      box-shadow: 0 10px 25px -5px rgba(0,0,0,0.4);
    }}
    .badge {{
      display: inline-block; background: rgba(16, 185, 129, 0.15); color: #10b981;
      padding: 4px 10px; border-radius: 6px; font-size: 12px; font-weight: 600; margin-bottom: 14px;
    }}
    h1 {{ font-size: 24px; color: #ffffff; margin: 0 0 16px 0; line-height: 1.3; }}
    .meta-bar {{
      display: flex; gap: 24px; padding-bottom: 24px; border-bottom: 1px solid #243247;
      color: #94a3b8; font-size: 14px; margin-bottom: 24px;
    }}
    .meta-val {{ color: #ffffff; font-weight: 700; }}
    .description {{ font-size: 15px; line-height: 1.7; color: #cbd5e1; white-space: pre-wrap; }}
    .client-sidebar {{
      margin-top: 32px; padding: 20px; background: #0f1624; border-radius: 12px;
      border: 1px solid #1f293d; display: flex; justify-content: space-between; align-items: center;
    }}
    .client-stat {{ text-align: left; }}
    .client-stat-title {{ font-size: 12px; color: #64748b; }}
    .client-stat-val {{ font-size: 15px; font-weight: 700; color: #e2e8f0; margin-top: 4px; }}
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
        <div>Hire Rate: <span class="meta-val text-emerald-400">{hire_rate}</span></div>
      </div>
      <div class="description">{desc}</div>
      <div class="client-sidebar">
        <div class="client-stat">
          <div class="client-stat-title">Client Total Spent</div>
          <div class="client-stat-val">{spent}</div>
        </div>
        <div class="client-stat">
          <div class="client-stat-title">Client Hire Rate</div>
          <div class="client-stat-val" style="color: #10b981;">{hire_rate}</div>
        </div>
        <div class="client-stat">
          <div class="client-stat-title">Payment Verification</div>
          <div class="client-stat-val" style="color: #38bdf8;">Verified</div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>"""
    return html

def record_job_scroll_frames(job, output_intro_path, target_url=None):
    """Records 5 seconds of smooth scrolling on the job page."""
    import imageio
    frames = []
    width, height = 1280, 720
    fps = 15
    duration_secs = 5
    total_frames = duration_secs * fps

    # Try SeleniumBase Driver first
    driver = None
    try:
        from seleniumbase import Driver
        print("Launching SeleniumBase UC Mode to capture job post...")
        driver = Driver(uc=True, headless=True, window_size=f"{width},{height}")

        # Check if target_url works or fallback to local generated HTML
        loaded_live = False
        if target_url and target_url.startswith('http'):
            try:
                driver.get(target_url)
                time.sleep(2)
                if "upwork.com" in driver.current_url and driver.title:
                    loaded_live = True
            except Exception as ex:
                print(f"Could not load live URL: {ex}", file=sys.stderr)

        if not loaded_live:
            # Render local high-fidelity HTML file
            temp_html_path = os.path.abspath("temp_job_render.html")
            with open(temp_html_path, "w", encoding="utf-8") as f:
                f.write(generate_local_job_html(job))
            driver.get(f"file:///{temp_html_path}")
            time.sleep(1)

        # Smooth scroll and capture frames
        for f_idx in range(total_frames):
            # Scroll down slowly 7-10 pixels per frame
            driver.execute_script("window.scrollBy({top: 8, behavior: 'instant'});")
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
        print(f"SeleniumBase capture error (using fallback synthetic scroll): {e}", file=sys.stderr)
        # Synthetic scroll fallback
        title = job.get('title', 'Upwork Project')
        for f_idx in range(total_frames):
            img = Image.new('RGB', (width, height), color=(15, 20, 34))
            draw = ImageDraw.Draw(img)
            draw.rectangle([0, 0, width, 60], fill=(22, 28, 48))
            draw.text((40, 20), "upwork  |  Job Post Preview", fill=(16, 185, 129))
            
            # Simulate scrolling card
            scroll_offset = f_idx * 6
            card_y = 100 - scroll_offset
            draw.rounded_rectangle([40, card_y, width - 40, card_y + 800], radius=12, fill=(22, 28, 48), outline=(31, 41, 61), width=2)
            draw.text((60, card_y + 30), f"TARGET JOB: {title}", fill=(255, 255, 255))
            draw.text((60, card_y + 70), "Client: Payment Verified  |  Budget: High Priority", fill=(56, 189, 248))
            draw.text((60, card_y + 110), "Full description reviewing in progress...", fill=(148, 163, 184))
            frames.append(np.array(img))

    finally:
        if driver:
            try:
                driver.quit()
            except:
                pass

    # Save intro video
    imageio.mimsave(output_intro_path, frames, fps=fps, codec='libx264')
    print(f"Saved job scroll intro to: {output_intro_path}")
    return output_intro_path

def stitch_videos(intro_path, master_path, final_output_path):
    """Concatenates intro scroll clip and master profile clip into a seamless MP4."""
    from moviepy import VideoFileClip, concatenate_videoclips
    
    print(f"Stitching {intro_path} + {master_path} -> {final_output_path}...")
    clip_intro = VideoFileClip(intro_path)
    clip_master = VideoFileClip(master_path)

    # Resize intro to match master dimensions if needed
    if clip_intro.size != clip_master.size:
        clip_intro = clip_intro.resized(clip_master.size)

    final_clip = concatenate_videoclips([clip_intro, clip_master], method="compose")
    final_clip.write_videofile(
        final_output_path,
        fps=24,
        codec="libx264",
        audio_codec="aac" if clip_master.audio else None,
        preset="fast"
    )
    print(f"Final stitched video successfully created at: {final_output_path}")

def main():
    parser = argparse.ArgumentParser(description="Record job scroll and stitch with master profile video.")
    parser.add_argument("--job-id", required=True, help="Upwork Job ID")
    parser.add_argument("--url", help="Job URL (optional)")
    parser.add_argument("--master", default="assets/master_profile.mp4", help="Path to master profile video")
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
    intro_temp = os.path.join(args.output_dir, f"temp_intro_{job_id}.mp4")
    final_output = os.path.join(args.output_dir, f"{job_id}.mp4")

    # 1. Record job scroll intro
    record_job_scroll_frames(job, intro_temp, job_url)

    # 2. Verify master video exists
    if not os.path.exists(args.master):
        print(f"Master profile video not found at {args.master}, generating placeholder...")
        from generate_placeholder_master import output_path as gen_path

    # 3. Stitch videos together
    stitch_videos(intro_temp, args.master, final_output)

    # Clean up temp intro
    if os.path.exists(intro_temp):
        try:
            os.remove(intro_temp)
        except:
            pass

    # 4. Generate proposal hook text
    proposal_text = (
        f"Hey there,\n\n"
        f"I saw your post regarding '{job.get('title', 'your project')}'. "
        f"Instead of a long generic proposal, I recorded a quick 1-minute Loom video walking through "
        f"your exact requirements and how I will execute this:\n\n"
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

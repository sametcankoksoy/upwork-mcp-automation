"""
High-Definition Human-Physics Loom Generator
- 1080p Full HD Razor-Sharp Resolution (CRF 17, 8Mbps bitrate)
- Realistic Human Reading & Scrolling Curve (Reading pauses + smooth cubic easing + micro-jitters)
- Polished Loom Circular Webcam Bubble with drop-shadow and anti-aliased border
"""
import os
import re
import sys
import math
import json
import sqlite3
import argparse
import subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont
import imageio
import imageio_ffmpeg


def _parse_money(val):
    if isinstance(val, (int, float)):
        return float(val)
    if not val:
        return 0.0
    cleaned = re.sub(r"[^0-9.]", "", str(val))
    try:
        return float(cleaned) if cleaned else 0.0
    except ValueError:
        return 0.0


def enrich_job_via_mcp(job_id, job_dict):
    """Fetch full untruncated job description & client_record via Node.js Official Upwork MCP client."""
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
    db_path = os.path.join(repo_root, "data", "upwork_analytics.sqlite")

    node_script = r"""
    (async () => {
      const { getValidAccessToken } = require('./src/upwork-oauth');
      const { getSetting } = require('./src/db');
      const token = await getValidAccessToken();
      const orgUid = getSetting('upwork_org_uid');
      if (!token || !orgUid) process.exit(2);
      const url = process.env.UPWORK_MCP_URL || 'https://mcp.upwork.com/mcp';
      const headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Authorization': 'Bearer ' + token
      };
      const r1 = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'initialize',
          params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'upwork-loom-stitcher', version: '1.0.0' } }
        })
      });
      const sid = r1.headers.get('mcp-session-id');
      if (!sid) process.exit(3);
      const r2 = await fetch(url, {
        method: 'POST',
        headers: { ...headers, 'mcp-session-id': sid },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'upwork__find_jobs', arguments: { action: 'get', org_uid: String(orgUid), params: { job_id: String(process.argv[1]) } } }
        })
      });
      const txt = await r2.text();
      const dataLine = txt.split('\n').find(l => l.startsWith('data:'));
      const rpc = dataLine ? JSON.parse(dataLine.slice(5)) : JSON.parse(txt);
      const contentText = rpc?.result?.content?.[0]?.text;
      if (!contentText) process.exit(4);
      console.log(contentText);
    })().catch(e => { console.error(e.message); process.exit(1); });
    """

    try:
        res = subprocess.run(
            ["node", "-e", node_script, str(job_id)],
            cwd=repo_root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=25
        )
        if res.returncode != 0 or not res.stdout.strip():
            err_msg = (res.stderr or "").strip() or f"exit {res.returncode}"
            print(f"MCP enrich notice (using DB fallback): {err_msg}", file=sys.stderr)
            return job_dict

        payload = json.loads(res.stdout.strip())
        if payload.get("status") == "error":
            print(f"MCP enrich warning: {payload.get('error_code')} {payload.get('reason')}", file=sys.stderr)
            return job_dict

        jp = (payload.get("data") or {}).get("marketplaceJobPosting") or {}
        jp_content = jp.get("content") or {}
        cr = payload.get("client_record") or {}
        comp = jp.get("clientCompanyPublic") or {}
        terms = jp.get("contractTerms") or {}
        cls = jp.get("classification") or {}

        raw_desc = jp_content.get("description") or ""
        clean_desc = re.sub(r"</?untrusted_participant_content>", "", raw_desc).strip()
        if clean_desc:
            job_dict["description"] = clean_desc

        if jp_content.get("title"):
            job_dict["title"] = jp_content["title"].strip()

        if cr:
            if cr.get("hire_rate_percent") is not None:
                job_dict["client_hire_rate"] = float(cr["hire_rate_percent"])
            if cr.get("spend_total"):
                job_dict["client_total_spent"] = _parse_money(cr["spend_total"])
            if cr.get("jobs_posted") is not None:
                job_dict["client_total_posted"] = int(cr["jobs_posted"])
            if cr.get("jobs_with_hires") is not None:
                job_dict["client_total_hires"] = int(cr["jobs_with_hires"])
            if cr.get("feedback_score") is not None:
                job_dict["client_rating"] = float(cr["feedback_score"])
            if cr.get("feedback_count") is not None:
                job_dict["client_feedback_count"] = int(cr["feedback_count"])

        country_name = ((comp.get("country") or {}).get("name")) or job_dict.get("client_country")
        if country_name:
            job_dict["client_country"] = country_name
        if comp.get("state"):
            job_dict["client_state"] = comp["state"]

        cat_label = (cls.get("category") or {}).get("preferredLabel")
        sub_label = (cls.get("subCategory") or {}).get("preferredLabel")
        if cat_label:
            job_dict["category"] = cat_label
        if sub_label:
            job_dict["subcategory"] = sub_label

        if terms.get("experienceLevel"):
            job_dict["experience_level"] = terms["experienceLevel"]
        contract_type = terms.get("contractType")
        if contract_type == "FIXED":
            job_dict["job_type"] = "Fixed"
            amt = ((terms.get("fixedPriceContractTerms") or {}).get("amount") or {}).get("rawValue")
            if amt:
                job_dict["budget"] = _parse_money(amt)
        elif contract_type == "HOURLY":
            job_dict["job_type"] = "Hourly"
            hr = terms.get("hourlyContractTerms") or {}
            hmin = ((hr.get("hourlyBudgetMin") or {}).get("rawValue"))
            hmax = ((hr.get("hourlyBudgetMax") or {}).get("rawValue"))
            if hmin:
                job_dict["hourly_min"] = _parse_money(hmin)
            if hmax:
                job_dict["hourly_max"] = _parse_money(hmax)

        # Persist enriched full description & stats back to SQLite
        if os.path.exists(db_path):
            try:
                conn = sqlite3.connect(db_path)
                conn.execute(
                    """
                    UPDATE jobs
                    SET title = ?, description = ?, client_hire_rate = ?, client_total_spent = ?,
                        client_total_posted = ?, client_total_hires = ?, client_rating = ?, client_country = ?
                    WHERE job_id = ?
                    """,
                    (
                        job_dict.get("title"),
                        job_dict.get("description"),
                        job_dict.get("client_hire_rate", 0),
                        job_dict.get("client_total_spent", 0),
                        job_dict.get("client_total_posted", 0),
                        job_dict.get("client_total_hires", 0),
                        job_dict.get("client_rating", 0),
                        job_dict.get("client_country", "United States"),
                        str(job_id)
                    )
                )
                conn.commit()
                conn.close()
                print(f"MCP enriched full job description ({len(clean_desc)} chars) & updated SQLite.")
            except Exception as db_ex:
                print(f"DB update notice after MCP enrich: {db_ex}", file=sys.stderr)

    except Exception as ex:
        print(f"MCP enrich notice (using DB fallback): {ex}", file=sys.stderr)

    return job_dict

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
    Symmetric ultra-fast mouse-wheel inspection:
    - 0 to 1.2s: Stays at top looking at title & budget
    - 1.2s to 2.6s (28 frames = 1.4s): FAST ENERGETIC DOWNWARD WHIP to bottom!
    - 2.6s to 7.0s (88 frames = 4.4s): Deep reading & inspecting client stats & scope at bottom
    - 7.0s to 8.4s (28 frames = 1.4s): FAST ENERGETIC UPWARD WHIP back up to top!
    - 8.4s to 15.0s: Rest cleanly at top hero section while delivering pitch
    """
    if max_scroll <= 10:
        return 0

    # Phase 1: 0 - 24 frames (0 - 1.2s) -> Looking at top
    if f < 24:
        return 0

    # Phase 2: 24 - 52 frames (1.2s - 2.6s) -> FAST DOWNWARD WHIP (1.4 seconds)
    elif f < 52:
        p = (f - 24) / 28.0
        ease = 1.0 - (1.0 - p)**3
        return int(ease * max_scroll)

    # Phase 3: 52 - 140 frames (2.6s - 7.0s) -> Reading bottom client stats & deliverables (4.4 seconds)
    elif f < 140:
        micro = np.sin((f - 52) * 0.15) * 2.0
        return int(max_scroll - abs(micro))

    # Phase 4: 140 - 168 frames (7.0s - 8.4s) -> FAST UPWARD WHIP (1.4 seconds)
    elif f < 168:
        p = (f - 140) / 28.0
        ease = 1.0 - (1.0 - p)**3
        return int(max_scroll * (1.0 - ease))

    # Phase 5: 168 - 300 frames (8.4s - 15.0s) -> Rest cleanly at top for pitch
    else:
        return 0

def _load_font(filename, size):
    candidates = [
        os.path.join(r"C:\Windows\Fonts", filename),
        filename
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                pass
    return ImageFont.load_default()


def _text_width(draw, text, font):
    if not text:
        return 0
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0]


def _wrap_text(draw, text, font, max_width):
    lines = []
    for paragraph in str(text).splitlines():
        para = paragraph.rstrip()
        if not para:
            lines.append("")
            continue
        words = para.split(" ")
        current = ""
        for word in words:
            candidate = word if not current else f"{current} {word}"
            if _text_width(draw, candidate, font) <= max_width:
                current = candidate
            else:
                if current:
                    lines.append(current)
                    current = word
                else:
                    # Break very long tokens cleanly
                    chunk = ""
                    for ch in word:
                        if _text_width(draw, chunk + ch, font) <= max_width:
                            chunk += ch
                        else:
                            lines.append(chunk)
                            chunk = ch
                    current = chunk
        if current:
            lines.append(current)
    return lines


def _draw_star(draw, cx, cy, r_outer, r_inner, fill):
    pts = []
    for i in range(10):
        angle = math.radians(-90 + i * 36)
        r = r_outer if i % 2 == 0 else r_inner
        pts.append((cx + r * math.cos(angle), cy + r * math.sin(angle)))
    draw.polygon(pts, fill=fill)


def _draw_globe(draw, cx, cy, r, color):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], outline=color, width=2)
    draw.ellipse([cx - r * 0.45, cy - r, cx + r * 0.45, cy + r], outline=color, width=1)
    draw.line([cx - r, cy, cx + r, cy], fill=color, width=1)


def _draw_verified_badge(draw, cx, cy, r, fill, check_color="#FFFFFF"):
    draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=fill)
    draw.line(
        [(cx - r * 0.42, cy + r * 0.04), (cx - r * 0.1, cy + r * 0.36), (cx + r * 0.46, cy - r * 0.34)],
        fill=check_color,
        width=2
    )


def render_upwork_job_canvas(job):
    """Renders an authentic 1920px-wide Upwork Job Details canvas using Pillow & Windows Segoe UI."""
    BORDER = "#E4EBE4"
    GREEN = "#108A00"
    INK = "#001E00"
    MUTED = "#5E6D55"
    PILL_BG = "#F2F7F2"

    f_logo = _load_font("segoeuib.ttf", 34)
    f_nav = _load_font("segoeuisl.ttf", 16)
    f_bread = _load_font("segoeuisl.ttf", 15)
    f_h1 = _load_font("segoeuib.ttf", 31)
    f_body = _load_font("segoeui.ttf", 19)
    f_body_bold = _load_font("segoeuib.ttf", 18)
    f_meta = _load_font("segoeui.ttf", 16)
    f_term_val = _load_font("segoeuib.ttf", 20)
    f_term_lbl = _load_font("segoeui.ttf", 15)
    f_sec_title = _load_font("segoeuib.ttf", 21)
    f_pill = _load_font("segoeuisl.ttf", 15)

    title = str(job.get("title") or "Senior AI & Automation Engineer")
    raw_desc = str(job.get("description") or "Looking for an experienced engineer to build automation workflows.")
    raw_desc = re.sub(r"</?untrusted_participant_content>", "", raw_desc).strip()

    is_fixed = (job.get("job_type") == "Fixed") or (float(job.get("budget") or 0) > 0)
    if is_fixed and float(job.get("budget") or 0) > 0:
        budget_main = f"${float(job.get('budget')):,.0f}"
        budget_sub = "Fixed-price"
    else:
        hmin = float(job.get("hourly_min") or 30)
        hmax = float(job.get("hourly_max") or 65)
        budget_main = f"${hmin:,.0f} - ${hmax:,.0f}"
        budget_sub = "Hourly rate"

    country = str(job.get("client_country") or "United States")
    state = str(job.get("client_state") or "")
    location_line = f"{country}" + (f" · {state}" if state else "")
    hire_rate_num = float(job.get("client_hire_rate") or 80)
    hire_rate = f"{hire_rate_num:.0f}%"
    spent = f"${float(job.get('client_total_spent') or 15000):,.0f}"
    posted_jobs = int(job.get("client_total_posted") or 18)
    total_hires = int(job.get("client_total_hires") or 0)
    rating = float(job.get("client_rating") or 4.9)
    fb_count = int(job.get("client_feedback_count") or max(1, total_hires))
    verified = int(job.get("client_payment_verified", 1)) == 1
    exp_level = str(job.get("experience_level") or "Expert").title()
    category = str(job.get("category") or job.get("keyword_matched") or "AI & Automation")
    subcategory = str(job.get("subcategory") or "Web & Automation Engineering")
    proposals_tier = str(job.get("current_proposals_tier") or "Less than 5")
    posted_label = f"Posted {str(job['posted_at'])[:10]}" if job.get("posted_at") else "Posted recently"

    # Layout constants
    W = 1920
    card_x0, card_x1 = 340, 1660
    main_x1 = 1270
    card_top = 148
    pad_x = 40
    main_text_w = (main_x1 - card_x0) - 2 * pad_x

    # Measure text blocks on scratch canvas
    scratch = Image.new("RGB", (10, 10), "#FFFFFF")
    sdraw = ImageDraw.Draw(scratch)
    title_lines = _wrap_text(sdraw, title, f_h1, main_text_w)
    desc_lines = _wrap_text(sdraw, raw_desc, f_body, main_text_w)

    sec1_h = 34 + len(title_lines) * 42 + 16 + 26 + 32
    sec2_h = 32 + max(4, len(desc_lines)) * 30 + 34
    sec3_h = 30 + 62 + 30
    sec4_h = 30 + 36 + 52 + 36
    left_bottom = card_top + sec1_h + sec2_h + sec3_h + sec4_h
    right_bottom = card_top + 178 + 430 + 185
    card_bottom = max(left_bottom, right_bottom)
    tall_h = max(1450, card_bottom + 140)

    img = Image.new("RGB", (W, tall_h), "#FFFFFF")
    draw = ImageDraw.Draw(img)

    # Top Navigation Bar
    draw.rectangle([0, 0, W, 78], fill="#FFFFFF")
    draw.line([0, 78, W, 78], fill=BORDER, width=1)
    draw.text((64, 17), "upwork", font=f_logo, fill=GREEN)

    nav_x = 240
    for item in ["Find work", "Deliver work", "Manage finances", "Messages"]:
        draw.text((nav_x, 29), item, font=f_nav, fill=INK)
        nav_x += _text_width(draw, item, f_nav) + 34

    # Search pill top-right
    draw.rounded_rectangle([1470, 18, 1856, 60], radius=21, fill="#F9FAFB", outline="#D5E0D5", width=1)
    draw.text((1492, 29), "Search jobs", font=f_meta, fill=MUTED)
    draw.text((1788, 29), "Jobs", font=f_nav, fill=GREEN)

    # Breadcrumb
    draw.text((card_x0, 106), category, font=f_bread, fill=GREEN)
    cat_w = _text_width(draw, category, f_bread)
    draw.text((card_x0 + cat_w + 10, 106), f">  {subcategory}", font=f_bread, fill=MUTED)
    job_id_txt = f"Job ID: ~02{job.get('job_id', '')}"
    jid_w = _text_width(draw, job_id_txt, f_bread)
    draw.text((card_x1 - jid_w, 106), job_id_txt, font=f_bread, fill=MUTED)

    # Main Two-Column Card
    draw.rounded_rectangle([card_x0, card_top, card_x1, card_bottom], radius=16, fill="#FFFFFF", outline=BORDER, width=2)
    draw.line([main_x1, card_top, main_x1, card_bottom], fill=BORDER, width=1)

    # Left Column Section 1: Title + Meta
    cur_y = card_top + 34
    lx = card_x0 + pad_x
    for line in title_lines:
        draw.text((lx, cur_y), line, font=f_h1, fill=INK)
        cur_y += 42
    cur_y += 14
    draw.text((lx, cur_y), posted_label, font=f_meta, fill=MUTED)
    pl_w = _text_width(draw, posted_label, f_meta)
    draw.text((lx + pl_w + 14, cur_y), "·", font=f_meta, fill=MUTED)
    _draw_globe(draw, lx + pl_w + 42, cur_y + 11, 9, MUTED)
    draw.text((lx + pl_w + 58, cur_y), "Worldwide", font=f_meta, fill=INK)

    sep1_y = card_top + sec1_h
    draw.line([card_x0, sep1_y, main_x1, sep1_y], fill=BORDER, width=1)

    # Left Column Section 2: Full Description
    cur_y = sep1_y + 32
    for line in desc_lines:
        if line:
            draw.text((lx, cur_y), line, font=f_body, fill=INK)
        cur_y += 30

    sep2_y = sep1_y + sec2_h
    draw.line([card_x0, sep2_y, main_x1, sep2_y], fill=BORDER, width=1)

    # Left Column Section 3: Contract Terms Grid
    ty = sep2_y + 30
    col_w = main_text_w // 3
    terms_cols = [
        (budget_main, budget_sub),
        (exp_level, "Experience level"),
        (category[:24], subcategory[:28]),
    ]
    for idx, (val_txt, lbl_txt) in enumerate(terms_cols):
        cx = lx + idx * col_w
        draw.text((cx, ty), val_txt, font=f_term_val, fill=INK)
        draw.text((cx, ty + 30), lbl_txt, font=f_term_lbl, fill=MUTED)

    sep3_y = sep2_y + sec3_h
    draw.line([card_x0, sep3_y, main_x1, sep3_y], fill=BORDER, width=1)

    # Left Column Section 4: Skills & Expertise Pills
    py = sep3_y + 30
    draw.text((lx, py), "Skills and Expertise", font=f_sec_title, fill=INK)
    px = lx
    pill_y = py + 40
    for pill in [category, subcategory, "Automation Architecture", "Production Systems"]:
        pw = _text_width(draw, pill, f_pill) + 32
        if px + pw > main_x1 - pad_x:
            break
        draw.rounded_rectangle([px, pill_y, px + pw, pill_y + 36], radius=18, fill=PILL_BG, outline=BORDER, width=1)
        draw.text((px + 16, pill_y + 7), pill, font=f_pill, fill=INK)
        px += pw + 12

    # Right Sidebar
    sx = main_x1 + 32
    sw = (card_x1 - main_x1) - 64

    # Sidebar Box 1: Apply / Save CTAs
    sy = card_top + 32
    draw.rounded_rectangle([sx, sy, sx + sw, sy + 48], radius=24, fill=GREEN)
    ap_w = _text_width(draw, "Apply now", f_body_bold)
    draw.text((sx + (sw - ap_w) // 2, sy + 12), "Apply now", font=f_body_bold, fill="#FFFFFF")

    draw.rounded_rectangle([sx, sy + 64, sx + sw, sy + 112], radius=24, fill="#FFFFFF", outline=GREEN, width=2)
    sv_w = _text_width(draw, "Save job", f_body_bold)
    draw.text((sx + (sw - sv_w) // 2, sy + 76), "Save job", font=f_body_bold, fill=GREEN)

    rsep1 = card_top + 178
    draw.line([main_x1, rsep1, card_x1, rsep1], fill=BORDER, width=1)

    # Sidebar Box 2: About the client
    ry = rsep1 + 28
    draw.text((sx, ry), "About the client", font=f_sec_title, fill=INK)
    ry += 44

    _draw_verified_badge(draw, sx + 10, ry + 11, 10, GREEN if verified else "#D97706")
    draw.text((sx + 28, ry), "Payment method verified" if verified else "Payment unverified", font=f_body_bold, fill=INK)
    ry += 42

    for s_idx in range(5):
        _draw_star(draw, sx + 9 + s_idx * 22, ry + 11, 9, 4, GREEN)
    draw.text((sx + 120, ry - 1), f"{rating:.2f}", font=f_body_bold, fill=INK)
    draw.text((sx, ry + 26), f"{rating:.2f} of {fb_count} reviews", font=f_term_lbl, fill=MUTED)
    ry += 68

    draw.text((sx, ry), location_line, font=f_body_bold, fill=INK)
    draw.text((sx, ry + 26), "Verified client location", font=f_term_lbl, fill=MUTED)
    ry += 68

    draw.text((sx, ry), f"{posted_jobs} jobs posted", font=f_body_bold, fill=INK)
    draw.text((sx, ry + 26), f"{hire_rate} hire rate", font=f_term_lbl, fill=MUTED)
    ry += 68

    draw.text((sx, ry), f"{spent} total spent", font=f_body_bold, fill=INK)
    draw.text((sx, ry + 26), f"{total_hires} hires", font=f_term_lbl, fill=MUTED)

    rsep2 = rsep1 + 430
    draw.line([main_x1, rsep2, card_x1, rsep2], fill=BORDER, width=1)

    # Sidebar Box 3: Activity on this job
    ay = rsep2 + 28
    draw.text((sx, ay), "Activity on this job", font=f_sec_title, fill=INK)
    ay += 42
    act_rows = [
        ("Proposals:", proposals_tier),
        ("Interviewing:", str(int(job.get("interviewing_count") or 0))),
        ("Invites sent:", str(int(job.get("invites_sent") or 0))),
    ]
    for lbl, val in act_rows:
        draw.text((sx, ay), lbl, font=f_meta, fill=MUTED)
        vw = _text_width(draw, val, f_body_bold)
        draw.text((sx + sw - vw, ay - 1), val, font=f_body_bold, fill=INK)
        ay += 32

    return img, card_bottom


def record_job_background(job, output_bg_path, duration_secs, target_url=None):
    """
    Renders 1080p high-definition Upwork Job Details frames purely in Python (Pillow) + FFmpeg rawvideo pipe.
    Completely eliminates ChromeDriver / Cloudflare block pages and executes in a few seconds.
    """
    width, height = 1920, 1080
    fps = 20
    total_frames = max(1, int(round(duration_secs * fps)))

    print(f"Rendering pure-Python 1080p Upwork Job Details canvas for {duration_secs:.1f}s ({total_frames} frames)...")
    tall_img, card_bottom = render_upwork_job_canvas(job)
    tall_h = tall_img.height
    max_scroll = max(320, min(card_bottom - height + 70, tall_h - height))
    print(f"Canvas size: {width}x{tall_h}px | Text-bounded scroll depth: {max_scroll}px")

    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    compile_cmd = [
        ffmpeg_exe, "-y",
        "-loglevel", "error",
        "-f", "rawvideo",
        "-vcodec", "rawvideo",
        "-pix_fmt", "rgb24",
        "-s", f"{width}x{height}",
        "-r", str(fps),
        "-i", "pipe:0",
        "-c:v", "libx264",
        "-crf", "16",
        "-b:v", "10M",
        "-preset", "fast",
        "-pix_fmt", "yuv420p",
        output_bg_path
    ]

    proc = subprocess.Popen(compile_cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    frame_bytes_cache = {}
    try:
        for f_idx in range(total_frames):
            target_y = max(0, min(int(snappy_human_scroll(f_idx, total_frames, max_scroll)), tall_h - height))
            raw_bytes = frame_bytes_cache.get(target_y)
            if raw_bytes is None:
                cropped = tall_img.crop((0, target_y, width, target_y + height))
                raw_bytes = cropped.tobytes()
                frame_bytes_cache[target_y] = raw_bytes
            proc.stdin.write(raw_bytes)
    finally:
        if proc.stdin:
            proc.stdin.close()

    proc.wait()
    if proc.returncode != 0:
        raise RuntimeError(f"FFmpeg 1080p background encode failed with exit code {proc.returncode}")

    print(f"High-Def 1080p background video saved to: {output_bg_path}")
    return output_bg_path

def composite_webcam_over_job(bg_video_path, webcam_video_path, final_output_path):
    """
    Overlays high-res circular webcam bubble in bottom-left at 1080p.
    Includes anti-aliasing and crisp bitrate (CRF 18).
    """
    ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
    
    # 1080p layout: auto-crop center square to preserve aspect ratio, then 320x320 circular bubble at (50, H - 370)
    filter_str = (
        "[1:v]crop=min(iw\\,ih):min(iw\\,ih),scale=320:320,format=yuva420p,"
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
        "-movflags", "+faststart",
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
    job = enrich_job_via_mcp(job_id, job)

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

    clean_topic = re.sub(r'[^a-zA-Z0-9\s,.-]', '', job.get('title', 'similar systems')).strip().lower()
    proposal_text = (
        f"hey there, made you a quick loom video showing exactly how i'd handle this:\n\n"
        f"https://upwork-mcp-automation.onrender.com/loom/{job_id}\n\n"
        f"i've done this exact style of project before, i've built {clean_topic}\n\n"
        f"ps i've never had a bad review and only 5 stars on upwork so you're in safe hands"
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

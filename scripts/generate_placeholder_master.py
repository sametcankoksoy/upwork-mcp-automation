"""
Generate a professional placeholder master profile video (assets/master_profile.mp4)
if the user doesn't have one yet.
Uses moviepy and PIL/imageio to generate a 6-second dark-mode Upwork profile showcase.
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

os.makedirs('assets', exist_ok=True)
output_path = os.path.join('assets', 'master_profile.mp4')

if not os.path.exists(output_path):
    print("Generating placeholder master profile video...")
    width, height = 1280, 720
    fps = 20
    duration = 5  # 5 seconds
    total_frames = duration * fps

    frames = []
    for i in range(total_frames):
        img = Image.new('RGB', (width, height), color=(15, 20, 34))
        draw = ImageDraw.Draw(img)

        # Header bar
        draw.rectangle([0, 0, width, 70], fill=(22, 28, 48))
        draw.text((40, 25), "UPWORK TOP RATED FREELANCER | AI & AUTOMATION EXPERT", fill=(16, 185, 129))

        # Main profile card
        card_top = 110
        draw.rounded_rectangle([40, card_top, width - 40, height - 60], radius=16, fill=(22, 28, 48), outline=(31, 41, 61), width=2)

        # Profile circle / avatar
        draw.ellipse([80, card_top + 40, 200, card_top + 160], fill=(56, 189, 248), outline=(16, 185, 129), width=4)
        draw.text((125, card_top + 85), "ME", fill=(15, 20, 34))

        # Title & Stats
        draw.text((230, card_top + 45), "Senior Full-Stack & AI Automation Engineer", fill=(255, 255, 255))
        draw.text((230, card_top + 75), "100% Job Success Score | $100k+ Earned | Top Rated Plus", fill=(16, 185, 129))
        draw.text((230, card_top + 115), "Tech Stack: Python, Node.js, AI Agents, Playwright, React, LLMs", fill=(148, 163, 184))

        # Animated progress/timeline bar
        progress_w = int((i / total_frames) * (width - 160))
        draw.rectangle([80, card_top + 180, 80 + progress_w, card_top + 186], fill=(16, 185, 129))

        # Pitch highlights
        draw.text((80, card_top + 210), "> 50+ Completed End-to-End Automation & Web Scraping Pipelines", fill=(226, 232, 240))
        draw.text((80, card_top + 250), "> Clean, documented, enterprise-ready Python & Node.js architecture", fill=(226, 232, 240))
        draw.text((80, card_top + 290), "> Fast turnaround, daily async communication, and 100% satisfaction guarantee", fill=(226, 232, 240))

        # Bottom badge
        draw.rounded_rectangle([80, card_top + 360, 480, card_top + 420], radius=10, fill=(16, 185, 129))
        draw.text((110, card_top + 380), "[ READY TO SCALE YOUR WORKFLOW ]", fill=(15, 20, 34))

        frames.append(np.array(img))

    import imageio
    imageio.mimsave(output_path, frames, fps=fps, codec='libx264')
    print(f"Created placeholder master video at: {output_path}")
else:
    print(f"Master profile video already exists at: {output_path}")

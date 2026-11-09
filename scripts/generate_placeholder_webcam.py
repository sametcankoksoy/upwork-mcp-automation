"""
Create master_webcam.mp4 (circular talking head placeholder using actual Upwork profile photo + audio track)
"""
import os
import numpy as np
from PIL import Image, ImageDraw, ImageOps
import imageio
import imageio_ffmpeg
import subprocess

os.makedirs('assets', exist_ok=True)
webcam_path = os.path.join('assets', 'master_webcam.mp4')
pp_path = os.path.join('assets', 'profile_pic.jpg')

width, height = 320, 320
fps = 20
duration = 15  # 15 seconds
total_frames = duration * fps

# Load user profile picture if available
user_avatar = None
if os.path.exists(pp_path):
    try:
        raw_pp = Image.open(pp_path).convert('RGB')
        # Center-crop to square
        min_dim = min(raw_pp.size)
        left = (raw_pp.width - min_dim) // 2
        top = (raw_pp.height - min_dim) // 2
        raw_pp = raw_pp.crop((left, top, left + min_dim, top + min_dim))
        user_avatar = raw_pp.resize((260, 260), Image.Resampling.LANCZOS)
    except Exception as e:
        print("Could not load profile_pic.jpg:", e)

frames = []
for i in range(total_frames):
    img = Image.new('RGB', (width, height), color=(15, 23, 42)) # Slate 900
    draw = ImageDraw.Draw(img)

    if user_avatar:
        # Paste rounded avatar inside
        # Create circular mask for avatar
        mask = Image.new('L', (260, 260), 0)
        mask_draw = ImageDraw.Draw(mask)
        mask_draw.ellipse([0, 0, 260, 260], fill=255)
        
        img.paste(user_avatar, (30, 30), mask)
        
        # Draw emerald outer ring
        draw.ellipse([28, 28, 292, 292], outline=(16, 185, 129), width=5) # Emerald 500
    else:
        # Fallback circle
        draw.ellipse([30, 30, 290, 290], fill=(30, 41, 59), outline=(16, 185, 129), width=5)
        draw.ellipse([110, 80, 210, 180], fill=(56, 189, 248))
        draw.ellipse([70, 180, 250, 290], fill=(56, 189, 248))

    # Animated audio wave bars at bottom
    wave_h = max(3, int(14 + 10 * np.sin(i * 0.45)))
    wave_bg = (10, 15, 29)
    draw.rounded_rectangle([115, 248, 205, 282], radius=10, fill=wave_bg, outline=(16, 185, 129), width=1)
    
    # 4 equalizer bars
    draw.rectangle([130, 275 - wave_h, 136, 275], fill=(52, 211, 153))
    draw.rectangle([142, 275 - int(wave_h * 1.3), 148, 275], fill=(16, 185, 129))
    draw.rectangle([154, 275 - int(wave_h * 0.8), 160, 275], fill=(52, 211, 153))
    draw.rectangle([166, 275 - int(wave_h * 1.1), 172, 275], fill=(16, 185, 129))
    draw.rectangle([178, 275 - max(3, int(wave_h * 0.6)), 184, 275], fill=(52, 211, 153))

    frames.append(np.array(img))

temp_raw = "assets/temp_webcam_silent.mp4"
imageio.mimsave(temp_raw, frames, fps=fps, codec='libx264')

# Generate 15-second silent audio track with ffmpeg
ffmpeg_exe = imageio_ffmpeg.get_ffmpeg_exe()
cmd = [
    ffmpeg_exe, "-y",
    "-i", temp_raw,
    "-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo",
    "-c:v", "copy",
    "-c:a", "aac",
    "-shortest",
    webcam_path
]
subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
if os.path.exists(temp_raw):
    os.remove(temp_raw)

print(f"Created master_webcam.mp4 with real profile photo at: {webcam_path}")

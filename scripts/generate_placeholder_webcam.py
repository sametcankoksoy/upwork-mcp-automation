"""
Create a test master_webcam.mp4 (circular talking head placeholder with audio track)
"""
import os
import numpy as np
from PIL import Image, ImageDraw
import imageio
import imageio_ffmpeg
import subprocess

os.makedirs('assets', exist_ok=True)
webcam_path = os.path.join('assets', 'master_webcam.mp4')

width, height = 300, 300
fps = 20
duration = 15  # 15 seconds
total_frames = duration * fps

frames = []
for i in range(total_frames):
    img = Image.new('RGB', (width, height), color=(20, 26, 44))
    draw = ImageDraw.Draw(img)

    # Face circle
    draw.ellipse([20, 20, 280, 280], fill=(30, 41, 59), outline=(16, 185, 129), width=5)
    
    # Head & Shoulders silhouette
    draw.ellipse([100, 70, 200, 170], fill=(56, 189, 248))
    draw.ellipse([60, 170, 240, 290], fill=(56, 189, 248))

    # Animated speech wave bars at bottom
    wave_h = max(3, int(15 + 10 * np.sin(i * 0.4)))
    draw.rectangle([130, 210, 140, 210 + wave_h], fill=(16, 185, 129))
    draw.rectangle([145, 205, 155, 205 + int(wave_h * 1.3)], fill=(16, 185, 129))
    draw.rectangle([160, 210, 170, 210 + wave_h], fill=(16, 185, 129))

    # Name label
    draw.text((85, 255), "SAMET CAN KOKSOY", fill=(255, 255, 255))

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

print(f"Created master_webcam.mp4 at: {webcam_path}")

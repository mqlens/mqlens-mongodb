"""Export the recorded UI tour. Usage: python3 scripts/render-marketing-video.py /path/to/ffmpeg"""
import json
import re
import subprocess
import sys
from pathlib import Path

ffmpeg = sys.argv[1] if len(sys.argv) > 1 else 'ffmpeg'
source = Path('.superpowers/sdd/website-refresh/captures/main-video.txt').read_text().strip()
subprocess.run([ffmpeg, '-y', '-i', source, '-ss', '0.8', '-an', '-vf', 'setpts=2.7*PTS,fps=24', '-c:v', 'libx264', '-crf', '25', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'website/public/demo.mp4'], check=True)
subprocess.run([ffmpeg, '-y', '-ss', '3', '-t', '8', '-i', 'website/public/demo.mp4', '-filter_complex', 'fps=6,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=3', '-loop', '0', 'assets/demo.gif'], check=True)
probe = subprocess.run([ffmpeg, '-i', 'website/public/demo.mp4'], capture_output=True, text=True)
match = re.search(r'Duration: (\d+):(\d+):(\d+\.\d+)', probe.stderr)
if not match:
    raise RuntimeError('Could not read encoded video duration')
h, m, s = map(float, match.groups())
duration = round(h * 3600 + m * 60 + s, 2)
Path('website/src/data').mkdir(exist_ok=True)
Path('website/src/data/demo.json').write_text(json.dumps({'name':'MQLens MongoDB workspace demo', 'uploadDate':'2026-10-04T00:00:00Z', 'duration':f'PT{duration}S', 'width':1600, 'height':1000}, indent=2) + '\n')
print(f'Encoded demo: {duration}s; MP4 {Path("website/public/demo.mp4").stat().st_size:,} bytes; GIF {Path("assets/demo.gif").stat().st_size:,} bytes')

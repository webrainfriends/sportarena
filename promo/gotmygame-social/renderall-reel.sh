#!/bin/bash
# Renders every frame of the Reel (2160x3840) in 4 parallel workers, then encodes it with the soundtrack.
# Usage: renderall-reel.sh <workDir> <music.wav> <out.mp4> [frames=1320]
W=$1; M=$2; OUT=$3; N=${4:-1320}; mkdir -p $W
per=$(( (N+3)/4 ))
for i in 0 1 2 3; do a=$((i*per)); b=$(((i+1)*per)); [ $b -gt $N ] && b=$N; node render-reel.cjs $W $a $b 2 30 & done; wait
ffmpeg -y -loglevel error -framerate 30 -i $W/f%05d.jpg -i $M -c:v libx264 -preset slow -crf 15 -pix_fmt yuv420p -c:a aac -b:a 256k -shortest -movflags +faststart $OUT
echo done

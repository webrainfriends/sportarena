#!/bin/bash
# Renders every frame of one format at 2x (4K-class) in 4 parallel workers, then encodes with the soundtrack.
# Usage: renderall.sh <reel|yt|feed> <workDir> <music.wav> <out.mp4> [frames=1110]
fmt=$1; W=$2; M=$3; OUT=$4; N=${5:-1110}; mkdir -p $W/$fmt
per=$(( (N+3)/4 ))
for i in 0 1 2 3; do a=$((i*per)); b=$(((i+1)*per)); [ $b -gt $N ] && b=$N; node render.cjs $fmt $W/$fmt $a $b 2 30 & done; wait
ffmpeg -y -loglevel error -framerate 30 -i $W/$fmt/f%05d.jpg -i $M -c:v libx264 -preset slow -crf 16 -pix_fmt yuv420p -c:a aac -b:a 192k -shortest -movflags +faststart $OUT
echo done $fmt

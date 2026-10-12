# Landing-page promo video

The landing hero shows a portrait (9:16) promo card that autoplays, muted and looping, as soon as the page opens
(`apps/app/src/promo.js`).

## What plays

1. **Real footage, if present** — a video at `apps/app/public/promo.mp4` replaces the built-in scenes.
2. **Otherwise the built-in scenes** — one per feature: athletes, teams & matches, venues, event management,
   sponsors, physios & doctors, stats, hiring. Each scene shows a real photo if one exists at
   `apps/app/public/promo/<scene>.jpg` (`athletes`, `teams`, `venues`, `events`, `sponsors`, `medical`, `stats`,
   `hiring`); with no photo it shows the gradient and icon. No sample people or numbers are bundled.

## Producing the 4K film

Shoot or license real footage (releases signed by every person on screen, sponsor logos cleared), edit it to 9:16, then encode:

```sh
ffmpeg -i master.mov -vf "scale=2160:3840:flags=lanczos,fps=30" -an \
  -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -movflags +faststart apps/app/public/promo.mp4
```

Keep it under ~25 MB so it starts quickly (raise `-crf` to shrink); a 1080×1920 copy for phones is also fine. The
file is muted by design — browsers only autoplay muted video.

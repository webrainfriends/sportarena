# Screen-facing portraits for the Reel

`composite-screens.py` needs each portrait to show the phone (or tablet) **screen facing the camera as a flat chroma-green
(#00FF00)**; it finds the green, warps the real app capture onto it in perspective and leaves fingers in front.
Generate each one with Figma's `generate_image` (model `gemini-3.1-flash-image`, 1152x2048, file `eRMSBP5hdKqK3XbDevJzd9`),
fetch the full-resolution result with `get_screenshot` (`enableBase64Response: true`, `maxDimension: 1376`; the file is saved by the tool
result, because www.figma.com is blocked for curl), and save it as `people/<name>.jpg`. The people are synthetic: keep the
"People shown are AI-generated" line on the end card.

Every prompt ends with: *The phone screen is a perfectly flat, uniform, pure chroma-key green (#00FF00) with no content, no glare, no
reflections, fully visible, only fingertips at the edges. Medium close-up from slightly above, shallow depth of field. No text, no logos, no watermarks.*
Also: *held at chest height, tilted so the screen faces the camera, large in the frame (about a third of the image width).*

| file | subject | feature |
|---|---|---|
| home | young Indian woman footballer, teal training top, floodlit pitch at golden hour, delighted and curious | Home |
| tournament | Indian man ~32, tournament organiser, navy polo and blank lanyard, busy multi-sport tournament behind | Tournaments |
| venue | young Indian woman badminton player in a white top, racket under her arm, bright indoor court | Venues |
| coach | Indian male football coach ~45, navy training jacket and whistle, laughing with a young player in a green top; one phone between them | Coaching |
| athlete | young Indian man, cricketer in plain whites, on a bench at a sunlit ground, proud and curious | Player stats, passport |
| physio | young South Asian male athlete on a treatment bed, smiling with relief; female physio in a grey polo kneels beside him | Physio, health |
| doctor | Indian male sports doctor ~45 in a white coat holds a **tablet** (~40% of image width) to camera; young female athlete in a teal jacket beside him | Doctors |
| learning | young Indian man, student athlete, dark sports jacket and backpack, on sunlit campus steps with books | Learning |
| sponsor | Indian businesswoman ~45, navy blazer, sponsorship manager, young athletes blurred behind | Sponsors |
| team | five diverse young amateur athletes in plain kits celebrating; the woman in the centre holds a phone up in front of the group | Explore, hook, finale |

Then:

```sh
python3 -I composite-screens.py                         # people-hi/<portrait>__<screen>.jpg + quads.json
python3 -I music-cinematic.py music.wav 44 2.5 39.25
REEL_HTML=ad-reel-hands.html ./renderall-reel.sh work music.wav gotmygame-instagram-reel-9x16-4k.mp4
```

`ad-reel.html` is the earlier cut (people with a phone mock-up beside them); `ad-reel-hands.html` is the screens-in-hand cut.

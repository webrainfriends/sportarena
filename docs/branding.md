# Brand assets

The logo is one source image, cut into the sizes each surface needs. All are in `apps/app`:

| File | Used for |
| --- | --- |
| `assets/logo.png` (512) | `Logo` component: top bar, landing nav, sign-in hero, wherever a square mark is shown |
| `assets/logo-full.png` (1200×800) | `LogoFull` component: the full lockup with the "GotMyGame · The Sportsverse" wordmark, for wide dark surfaces |
| `assets/icon.png` (1024) | iOS and iPadOS app icon, Expo icon |
| `assets/adaptive-icon.png` (1024) | Android adaptive icon foreground (artwork kept inside the central 66% safe zone) |
| `assets/splash.png` | Splash screen: the full lockup on black (`splash.backgroundColor` is black) |
| `public/favicon.png`, `apple-touch-icon.png`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` | Web favicon and installable-app (PWA) icons |

The square mark is the "G" emblem on a near-black square; the wordmark is left out because it is unreadable at icon sizes. Screens never import an image directly: use `Logo` or `LogoFull` from `src/logo.js`.

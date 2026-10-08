import { useWindowDimensions } from 'react-native';

/**
 * Device class from the viewport, not the user agent — so a phone browser gets the phone app,
 * a tablet browser gets the tablet app, and a rotated phone / split-screen tablet adapts live.
 *   phone  < 768   : one column, edge-to-edge tab bar, bottom sheets
 *   tablet >= 768  : floating tab bar, master–detail split views, centred form sheets
 */
export function useLayout() {
  const { width, height } = useWindowDimensions();
  const tablet = width >= 768;
  return {
    width, height, tablet, phone: !tablet, landscape: width > height,
    // the tablet tab bar floats over the content, so scrolling screens reserve room for it
    floatingBar: tablet,
    bottomPad: tablet ? 116 : 24,
    gutter: tablet ? 24 : 16,
    contentMax: tablet ? 1180 : 760,
  };
}

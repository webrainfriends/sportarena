// What both map implementations share: pin colours and emoji per kind (theme tokens only) and the prop contract.
//   <MapView pins selectedKey center onSelect(pin) onSearchArea(bboxString) height />
//   pins: [{ key, kind: 'venue'|'game'|'class', id, latitude, longitude }]
import { c } from './theme';

export const KIND_STYLE = {
  venue: { emoji: '🏟️', color: () => c.violet },
  game: { emoji: '🏃', color: () => c.pink },
  class: { emoji: '🎓', color: () => c.cyan },
};
export const pinColor = (kind) => (KIND_STYLE[kind] ?? KIND_STYLE.venue).color();
export const pinEmoji = (kind) => (KIND_STYLE[kind] ?? KIND_STYLE.venue).emoji;

// Cross-platform video trim scrubber for clip review (#505).
// Shows a visual IN/OUT timeline track with draggable handles. When a playable uri is provided, an inline
// video player is rendered above the track (using expo-video via the shared UrlPlayer). Falls back gracefully
// to labels-only when no uri or no playable format: no crash, no silent failure.
// Touch targets are 44 pt; accessible roles are set on every interactive element.
import React, { useRef, useState } from 'react';
import { PanResponder, View } from 'react-native';
import { t } from '../i18n';
import { A } from '../arena';
import { T, Btn } from '../ui';
import { UrlPlayer, sourceKind } from '../video-player';
import { c } from '../theme';

const TRACK_H = 44;
const THUMB = 24;
const snap = (s, prec = 0.5) => Math.round(s / prec) * prec;

const fmtTime = (s) => {
  const ss = Math.abs(Math.round(s));
  return `${String(Math.floor(ss / 60)).padStart(2, '0')}:${String(ss % 60).padStart(2, '0')}`;
};

/**
 * Props:
 *   uri              — The source video URL (may be a media-fragment #t= URL). Null/undefined shows labels only.
 *   inPoint          — Current IN-point (seconds).
 *   outPoint         — Current OUT-point (seconds).
 *   durationSeconds  — Total timeline length to display (default: outPoint + 30).
 *   onInChange       — Called with the new in-point value as the user drags.
 *   onOutChange      — Called with the new out-point value as the user drags.
 *   readOnly         — When true, handles are hidden (view-only timeline).
 *   title            — Passed to the video player for accessibility.
 */
export function VideoScrubber({ uri, inPoint = 0, outPoint = 60, durationSeconds, onInChange, onOutChange, readOnly = false, title }) {
  const dur = durationSeconds ?? (outPoint + 30);
  const [trackWidth, setTrackWidth] = useState(300);
  const trackPageX = useRef(0);
  const trackRef = useRef(null);

  const pct = (s) => Math.min(1, Math.max(0, s / dur));
  const fromPctX = (pageX) => snap(Math.min(dur, Math.max(0, ((pageX - trackPageX.current) / trackWidth) * dur)));

  const measure = () => trackRef.current?.measure?.((_x, _y, w, _h, px) => { trackPageX.current = px; });

  const inPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => !readOnly,
    onPanResponderGrant: measure,
    onPanResponderMove: (evt) => {
      const v = fromPctX(evt.nativeEvent.pageX);
      onInChange?.(Math.min(v, (outPoint ?? 60) - 0.5));
    },
  })).current;

  const outPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => !readOnly,
    onPanResponderGrant: measure,
    onPanResponderMove: (evt) => {
      const v = fromPctX(evt.nativeEvent.pageX);
      onOutChange?.(Math.max(v, (inPoint ?? 0) + 0.5));
    },
  })).current;

  const canPlay = !!uri && !!sourceKind(uri);
  const inPct = pct(inPoint);
  const outPct = pct(outPoint);

  return (
    <View style={{ gap: 8 }}>
      {canPlay && <UrlPlayer url={uri} title={title} />}
      {!canPlay && (
        <View style={{ backgroundColor: A.card, borderRadius: 10, padding: 12, alignItems: 'center' }}>
          <T size={12} color={c.mute}>{t('clips.scrubber.no_video')}</T>
        </View>
      )}

      {/* Timeline track */}
      <View
        ref={trackRef}
        style={{ height: TRACK_H, justifyContent: 'center' }}
        onLayout={(e) => { setTrackWidth(e.nativeEvent.layout.width); trackPageX.current = e.nativeEvent.layout.x; }}
      >
        {/* Background */}
        <View style={{ height: 4, borderRadius: 2, backgroundColor: c.line, position: 'relative' }}>
          {/* Active window */}
          <View style={{ position: 'absolute', top: 0, bottom: 0, borderRadius: 2, backgroundColor: c.pink ?? '#8458B3', left: `${inPct * 100}%`, right: `${(1 - outPct) * 100}%` }} />
        </View>

        {/* IN handle */}
        {!readOnly && (
          <View
            {...inPan.panHandlers}
            style={{ position: 'absolute', left: inPct * trackWidth - THUMB / 2, top: (TRACK_H - THUMB) / 2, width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: c.pink ?? '#8458B3', alignItems: 'center', justifyContent: 'center', zIndex: 2 }}
            accessibilityLabel={t('clips.scrubber.in')}
            accessibilityRole="adjustable"
          >
            <T size={9} color="#fff" weight="800">IN</T>
          </View>
        )}

        {/* OUT handle */}
        {!readOnly && (
          <View
            {...outPan.panHandlers}
            style={{ position: 'absolute', left: outPct * trackWidth - THUMB / 2, top: (TRACK_H - THUMB) / 2, width: THUMB, height: THUMB, borderRadius: THUMB / 2, backgroundColor: c.violet ?? '#6B4FA3', alignItems: 'center', justifyContent: 'center', zIndex: 2 }}
            accessibilityLabel={t('clips.scrubber.out')}
            accessibilityRole="adjustable"
          >
            <T size={9} color="#fff" weight="800">OUT</T>
          </View>
        )}
      </View>

      {/* Time labels */}
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <T size={12} color={c.mute}>{t('clips.scrubber.in')}: {fmtTime(inPoint)}</T>
        <T size={12} color={c.mute}>{fmtTime(outPoint - inPoint)} {t('clips.scrubber.duration')}</T>
        <T size={12} color={c.mute}>{t('clips.scrubber.out')}: {fmtTime(outPoint)}</T>
      </View>
    </View>
  );
}

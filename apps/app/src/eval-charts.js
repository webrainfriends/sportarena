// Charts for evaluations, drawn with react-native-svg so they look the same on iOS, Android and the web. Colours come from the theme; every chart has a
// text alternative (accessibilityLabel) listing the same numbers, so nothing is only in the picture.
import React from 'react';
import { View } from 'react-native';
import Svg, { Circle, Line, Polygon, Polyline, Text as SvgText } from 'react-native-svg';
import { c, fam } from './theme';

/** Profile across the pillars (0 to 100). Series: [{ label, values: { axisKey: number|null }, color, dashed }]. */
export function RadarChart({ axes, series, size = 280, a11y }) {
  const cx = size / 2, cy = size / 2, R = size / 2 - 52, n = axes.length;
  if (n < 3) return null;
  const pt = (i, v) => { const a = (Math.PI * 2 * i) / n - Math.PI / 2; const r = (R * Math.max(0, Math.min(100, v))) / 100; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; };
  const ring = (p) => axes.map((_, i) => pt(i, p).join(',')).join(' ');
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={a11y} style={{ alignItems: 'center' }}>
      <Svg width={size} height={size}>
        {[25, 50, 75, 100].map((p) => <Polygon key={p} points={ring(p)} fill="none" stroke={c.line} strokeWidth={1} />)}
        {axes.map((_, i) => { const [x, y] = pt(i, 100); return <Line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke={c.line} strokeWidth={1} />; })}
        {series.map((s, k) => {
          const pts = axes.map((a, i) => pt(i, s.values[a.key] ?? 0));
          return (
            <React.Fragment key={k}>
              <Polygon points={pts.map((p) => p.join(',')).join(' ')} fill={s.color} fillOpacity={s.dashed ? 0 : 0.18} stroke={s.color} strokeWidth={2} strokeDasharray={s.dashed ? '5,4' : undefined} />
              {pts.map((p, i) => (s.values[axes[i].key] == null ? null : <Circle key={i} cx={p[0]} cy={p[1]} r={3.5} fill={s.color} />))}
            </React.Fragment>
          );
        })}
        {axes.map((a, i) => { const [x, y] = pt(i, 126); return <SvgText key={a.key} x={x} y={y + 4} fontSize={11} fontWeight="700" fill={c.ink} textAnchor="middle" {...(fam ?? {})}>{a.label}</SvgText>; })}
      </Svg>
    </View>
  );
}

/** One line per series over time. points: [{ at, values: { key: number|null } }]; lines: [{ key, label, color }]; y from 0 to 100 unless `domain`. */
export function TrendChart({ points, lines, width = 320, height = 150, domain = [0, 100], a11y }) {
  if (points.length < 1) return null;
  const pad = { l: 28, r: 10, t: 10, b: 18 }, w = width - pad.l - pad.r, h = height - pad.t - pad.b;
  const x = (i) => pad.l + (points.length === 1 ? w / 2 : (w * i) / (points.length - 1));
  const y = (v) => pad.t + h - ((v - domain[0]) / (domain[1] - domain[0])) * h;
  return (
    <View accessible accessibilityRole="image" accessibilityLabel={a11y}>
      <Svg width={width} height={height}>
        {[0, 50, 100].map((g) => { const yy = y(domain[0] + ((domain[1] - domain[0]) * g) / 100); return <React.Fragment key={g}><Line x1={pad.l} y1={yy} x2={width - pad.r} y2={yy} stroke={c.line} strokeWidth={1} /><SvgText x={pad.l - 4} y={yy + 3} fontSize={9} fill={c.mute} textAnchor="end" {...(fam ?? {})}>{Math.round(domain[0] + ((domain[1] - domain[0]) * g) / 100)}</SvgText></React.Fragment>; })}
        {lines.map((l) => {
          const pts = points.map((p, i) => (p.values[l.key] == null ? null : [x(i), y(p.values[l.key])])).filter(Boolean);
          return (
            <React.Fragment key={l.key}>
              {pts.length > 1 ? <Polyline points={pts.map((p) => p.join(',')).join(' ')} fill="none" stroke={l.color} strokeWidth={2.5} /> : null}
              {pts.map((p, i) => <Circle key={i} cx={p[0]} cy={p[1]} r={4} fill={l.color} />)}
            </React.Fragment>
          );
        })}
      </Svg>
    </View>
  );
}

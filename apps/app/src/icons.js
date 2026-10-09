import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

const P = (props) => ({ stroke: props.color, strokeWidth: props.on ? 2.2 : 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' });
const tint = (p) => (p.on ? p.color : 'none');
const wrap = (draw) => (props) => (
  <Svg width={props.size ?? 24} height={props.size ?? 24} viewBox="0 0 24 24">{draw(props)}</Svg>
);

export const icons = {
  Home: wrap((p) => <Path d="M3.5 11.2 12 4l8.5 7.2V19a1.5 1.5 0 0 1-1.5 1.5h-4.2V15H9.2v5.5H5A1.5 1.5 0 0 1 3.5 19z" {...P(p)} fill={tint(p)} fillOpacity={0.16} />),
  Play: wrap((p) => <>
    <Path d="M8 4h8v5.2a4 4 0 0 1-8 0z" {...P(p)} fill={tint(p)} fillOpacity={0.16} />
    <Path d="M8 6H5v1.2A3 3 0 0 0 8 10M16 6h3v1.2A3 3 0 0 1 16 10M12 13.2V17M9 20h6M10 17h4" {...P(p)} />
  </>),
  Player: wrap((p) => <>
    <Circle cx="12" cy="9" r="5" {...P(p)} fill={tint(p)} fillOpacity={0.16} />
    <Path d="M8.6 13.4 7 21l5-3 5 3-1.6-7.6" {...P(p)} />
  </>),
  Book: wrap((p) => <>
    <Rect x="3.5" y="5" width="17" height="15.5" rx="3" {...P(p)} fill={tint(p)} fillOpacity={0.16} />
    <Path d="M3.5 10h17M8 3v4M16 3v4" {...P(p)} />
  </>),
  Hub: wrap((p) => <>
    {[[4, 4], [13.5, 4], [4, 13.5], [13.5, 13.5]].map(([x, y]) => <Rect key={`${x}${y}`} x={x} y={y} width="6.5" height="6.5" rx="2" {...P(p)} fill={tint(p)} fillOpacity={0.16} />)}
  </>),
  Me: wrap((p) => <>
    <Circle cx="12" cy="8.5" r="4" {...P(p)} fill={tint(p)} fillOpacity={0.16} />
    <Path d="M4.5 20.5c.6-4 3.5-6 7.5-6s6.9 2 7.5 6" {...P(p)} />
  </>),
  Bell: wrap((p) => <Path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15zM10 20.5a2 2 0 0 0 4 0" {...P(p)} />),
  Back: wrap((p) => <Path d="M14.5 5.5 8 12l6.5 6.5" {...P(p)} strokeWidth={2.4} />),
};
export const Icon = ({ name, ...p }) => { const I = icons[name]; return I ? <I {...p} /> : null; };

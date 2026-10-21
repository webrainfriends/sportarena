import React from 'react';
import Svg, { Circle, Path, Rect } from 'react-native-svg';

const P = (props) => ({ stroke: props.color, strokeWidth: props.on ? 2.2 : 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', fill: 'none' });
const tint = (p) => (p.on ? p.color : 'none');
const wrap = (draw) => (props) => (
  <Svg width={props.size ?? 24} height={props.size ?? 24} viewBox="0 0 24 24">{draw(props)}</Svg>
);

export const icons = {
  Home: wrap((p) => <Path d="M3.5 11.2 12 4l8.5 7.2V19a1.5 1.5 0 0 1-1.5 1.5h-4.2V15H9.2v5.5H5A1.5 1.5 0 0 1 3.5 19z" {...P(p)} fill={tint(p)} fillOpacity={0.16} />),
  Explore: wrap((p) => <>
    <Circle cx="12" cy="12" r="8.5" {...P(p)} fill={tint(p)} fillOpacity={0.16} />
    <Path d="m15.6 8.4-2 5.2-5.2 2 2-5.2z" {...P(p)} />
  </>),
  Player: wrap((p) => <>
    <Circle cx="12" cy="9" r="5" {...P(p)} fill={tint(p)} fillOpacity={0.16} />
    <Path d="M8.6 13.4 7 21l5-3 5 3-1.6-7.6" {...P(p)} />
  </>),
  Schedule: wrap((p) => <>
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
  Billboard: wrap((p) => <><Path d="M4 10v4h3l7 4V6L7 10z" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Path d="M17.5 9a4 4 0 0 1 0 6M7 14l1.2 5h2.3L9.6 15.5" {...P(p)} /></>),
  Shop: wrap((p) => <><Path d="M5 8h14l-1 12H6z" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Path d="M9 8V7a3 3 0 0 1 6 0v1" {...P(p)} /></>),
  Shield: wrap((p) => <Path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.3-7 9-4.1-1.7-7-4.8-7-9V6z" {...P(p)} fill={tint(p)} fillOpacity={0.16} />),
  ShieldCheck: wrap((p) => <><Path d="M12 3.5 19 6v5.5c0 4.2-2.9 7.3-7 9-4.1-1.7-7-4.8-7-9V6z" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Path d="m8.8 12 2.2 2.2 4.2-4.4" {...P(p)} /></>),
  Leaderboard: wrap((p) => <><Rect x="3.5" y="12" width="5" height="8" rx="1.5" {...P(p)} /><Rect x="9.5" y="5" width="5" height="15" rx="1.5" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Rect x="15.5" y="9" width="5" height="11" rx="1.5" {...P(p)} /></>),
  Health: wrap((p) => <><Path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.6 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Path d="M7.5 12h2.2l1.3-2.4 2 4.2 1.2-1.8h2.3" {...P(p)} /></>),
  Legal: wrap((p) => <><Path d="M12 4v16M7 20h10M5 7h14" {...P(p)} /><Path d="m5 7-2.5 6a3 3 0 0 0 5 0zM19 7l-2.5 6a3 3 0 0 0 5 0z" {...P(p)} fill={tint(p)} fillOpacity={0.16} /></>),
  Sponsors: wrap((p) => <><Path d="M7 4h10l3.5 5L12 20.5 3.5 9z" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Path d="M3.5 9h17M9.5 4 8 9l4 11.5L16 9l-1.5-5" {...P(p)} /></>),
  Supply: wrap((p) => <><Path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4z" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Path d="m3.5 7.5 8.5 4 8.5-4M12 11.5v9" {...P(p)} /></>),
  Openings: wrap((p) => <><Rect x="3.5" y="7.5" width="17" height="12" rx="2.5" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Path d="M9 7.5V6a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1.5M3.5 13h17" {...P(p)} /></>),
  EventInbox: wrap((p) => <><Rect x="3.5" y="5.5" width="17" height="13" rx="2.5" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Path d="m4 7.5 8 6 8-6" {...P(p)} /></>),
  Awards: wrap((p) => <><Path d="M8 4h8v5a4 4 0 0 1-8 0z" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Path d="M8 6H4.5v1.5A3 3 0 0 0 8 10.5M16 6h3.5v1.5a3 3 0 0 1-3.5 3M12 13v4M8.5 20h7M10 17h4" {...P(p)} /></>),
  Wallet: wrap((p) => <><Rect x="3.5" y="6" width="17" height="13" rx="3" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Path d="M3.5 10h17M16 14.5h1.5" {...P(p)} /></>),
  Earnings: wrap((p) => <><Circle cx="12" cy="12" r="8.5" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Path d="M14.5 9.2c-.5-.8-1.4-1.2-2.5-1.2-1.4 0-2.4.7-2.4 1.8 0 2.4 5 1.2 5 3.8 0 1.1-1.1 1.9-2.6 1.9-1.1 0-2.1-.5-2.6-1.4M12 6.5V8M12 16v1.5" {...P(p)} /></>),
  MyPlans: wrap((p) => <><Rect x="5" y="4.5" width="14" height="16" rx="2.5" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Path d="M9 4.5h6v2H9zM8.5 11l1.5 1.5L13 9.5M8.5 16.5h7" {...P(p)} /></>),
  Family: wrap((p) => <><Circle cx="8.5" cy="8" r="3" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Circle cx="16.5" cy="9" r="2.4" {...P(p)} /><Path d="M3 19.5c.4-3 2.5-4.8 5.5-4.8s5.1 1.8 5.5 4.8M15 14.8c2.6-.2 4.5 1.3 5 4" {...P(p)} /></>),
  Orgs: wrap((p) => <><Path d="M5 20.5V5.5a1.5 1.5 0 0 1 1.5-1.5h6A1.5 1.5 0 0 1 14 5.5v15" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Path d="M14 10h3.5A1.5 1.5 0 0 1 19 11.5v9M3.5 20.5h17M8.5 8h2M8.5 12h2M8.5 16h2" {...P(p)} /></>),
  Pathways: wrap((p) => <><Path d="m2.5 9.5 9.5-5 9.5 5-9.5 5z" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Path d="M6.5 12v4.2c0 1.3 2.5 2.8 5.5 2.8s5.5-1.5 5.5-2.8V12M21.5 9.5V15" {...P(p)} /></>),
  Support: wrap((p) => <><Circle cx="12" cy="12" r="8.5" {...P(p)} fill={tint(p)} fillOpacity={0.16} /><Circle cx="12" cy="12" r="3.2" {...P(p)} /><Path d="m6 6 3.8 3.8M18 6l-3.8 3.8M6 18l3.8-3.8M18 18l-3.8-3.8" {...P(p)} /></>),
  Search: wrap((p) => <><Circle cx="11" cy="11" r="6.5" {...P(p)} /><Path d="m16 16 4 4" {...P(p)} /></>),
  Back: wrap((p) => <Path d="M14.5 5.5 8 12l6.5 6.5" {...P(p)} strokeWidth={2.4} />),
};
export const Icon = ({ name, ...p }) => { const I = icons[name]; return I ? <I {...p} /> : null; };

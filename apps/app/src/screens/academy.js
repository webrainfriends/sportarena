// The Academy module inside an organisation workspace: Home (executive view), Admissions (board + review), Programmes, Families, Progress
// (pathways, assessments, decisions), Agreements, Finance (charges, P&L, receivables, costs, forecast), Partners, Announcements and Settings. On tablet/desktop the sections sit in a sidebar; on a phone they are a row of tabs. The server decides
// what each role may do; the module only hides what a role cannot use: a coach sees Progress only, finance sees Finance and Partners (sponsorship). Families and athletes use the AcademyFamily screen instead.
import React, { useState } from 'react';
import { View } from 'react-native';
import { useLayout } from '../layout';
import { useLoad } from '../hooks';
import { api } from '../api';
import { ModuleNav } from './academy-ui';
import { Home } from './academy-home';
import { Admissions } from './academy-admissions';
import { Programmes } from './academy-programmes';
import { Families } from './academy-families';
import { Agreements, Announcements, Settings } from './academy-money';
import { Finance } from './academy-books';
import { Progress } from './academy-progress';
import { Partners } from './academy-partners';
import { Empty } from '../ui';
import { Admissions as StudyDesk } from './admissions';

const ALL = [
  { key: 'home', label: 'Home', icon: '🏠' }, { key: 'admissions', label: 'Admissions', icon: '📥' }, { key: 'programmes', label: 'Programmes', icon: '🏅' }, { key: 'families', label: 'Families', icon: '👨‍👩‍👧' }, { key: 'progress', label: 'Progress', icon: '🪜' },
  { key: 'agreements', label: 'Agreements', icon: '📜' }, { key: 'billing', label: 'Finance', icon: '💷' }, { key: 'partners', label: 'Partners', icon: '🤝' }, { key: 'announce', label: 'Announcements', icon: '📣' }, { key: 'study', label: 'Study listing', icon: '🎓' }, { key: 'settings', label: 'Settings', icon: '⚙️' },
];

export function AcademyDesk({ o, role, archived, toast }) {
  const staff = role === 'owner' || role === 'admin';
  const items = staff ? ALL : role === 'coach' ? ALL.filter((i) => i.key === 'progress') : ALL.filter((i) => ['billing', 'partners'].includes(i.key));
  const [tab, setTab] = useState(staff ? 'home' : role === 'coach' ? 'progress' : 'billing');
  const [openApp, setOpenApp] = useState(null);
  const { tablet } = useLayout();
  const dash = useLoad(() => (staff ? api.get(`/organisations/${o.id}/academy/dashboard`) : Promise.resolve(null)), [o.id, staff]);
  const a = dash.data?.outstanding_actions;
  const badge = a ? { admissions: a.applications_to_review + a.offers_expiring + a.follow_ups_due } : {};
  const P = { o, role, archived, toast };
  const goTo = (key, id) => { setTab(key); if (key === 'admissions' && id) setOpenApp(id); };
  const openApplication = (id) => { setOpenApp(id); setTab('admissions'); };
  const body = !items.some((i) => i.key === tab) ? <Empty emoji="🔒" title="Not available for your role" /> : tab === 'home' ? <Home {...P} go={goTo} openApplication={openApplication} canMoney />
    : tab === 'admissions' ? <Admissions {...P} openId={openApp} setOpenId={setOpenApp} /> : tab === 'programmes' ? <Programmes {...P} onOpenApplication={openApplication} />
    : tab === 'families' ? <Families {...P} onOpenApplication={openApplication} /> : tab === 'agreements' ? <Agreements {...P} /> : tab === 'billing' ? <Finance {...P} /> : tab === 'progress' ? <Progress {...P} /> : tab === 'partners' ? <Partners {...P} />
    : tab === 'announce' ? <Announcements {...P} /> : tab === 'study' ? <StudyDesk {...P} /> : <Settings {...P} />;
  return (
    <View style={{ flexDirection: tablet ? 'row' : 'column', gap: tablet ? 20 : 0, marginTop: 10, alignItems: 'flex-start' }}>
      <ModuleNav items={items} value={tab} onChange={(k) => setTab(k)} badge={badge} />
      <View style={{ flex: tablet ? 1 : undefined, width: tablet ? undefined : '100%', minWidth: 0, marginTop: tablet ? 0 : 12 }}>{body}</View>
    </View>
  );
}

// The Academy module inside an organisation workspace: Home (executive view), Admissions (board + review), Programmes, Families, Progress
// (pathways, assessments, decisions), Curriculum (methodology library, versioned curricula, coverage), Agreements, Finance (charges, P&L, receivables, costs, forecast), Partners, Announcements and Settings. On tablet/desktop the sections sit in a sidebar; on a phone they are a row of tabs. The server decides
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
import { Operations } from './academy-ops';
import { SafetyDesk } from './academy-safety';
import { WellbeingDesk } from './academy-wellbeing';
import { Curriculum } from './academy-curriculum';
import { Academics } from './academics';
import { Competition } from './academy-competition';
import { Scouting } from './academy-scouting';
import { t } from '../i18n';

const ALL = [
  { key: 'home', label: 'Home', icon: '🏠' }, { key: 'ops', label: 'Operations', icon: '🗓️' }, { key: 'safety', label: t('pk.nav'), icon: '🛡️' }, { key: 'wellbeing', label: t('wb.nav'), icon: '💚' }, { key: 'admissions', label: 'Admissions', icon: '📥' }, { key: 'scouting', label: t('scout.nav'), icon: '🔭' }, { key: 'programmes', label: 'Programmes', icon: '🏅' }, { key: 'families', label: 'Families', icon: '👨‍👩‍👧' }, { key: 'progress', label: 'Progress', icon: '🪜' }, { key: 'curriculum', label: t('cur.nav'), icon: '🧭' }, { key: 'academics', label: 'Academics', icon: '🎓' }, { key: 'competition', label: t('cp.nav'), icon: '🏟️' },
  { key: 'agreements', label: 'Agreements', icon: '📜' }, { key: 'billing', label: 'Finance', icon: '💷' }, { key: 'partners', label: 'Partners', icon: '🤝' }, { key: 'announce', label: 'Announcements', icon: '📣' }, { key: 'study', label: 'Study listing', icon: '🎓' }, { key: 'settings', label: 'Settings', icon: '⚙️' },
];

export function AcademyDesk({ o, role, archived, toast, focus, go: orgGo }) {
  const staff = role === 'owner' || role === 'admin';
  // owners/admins get the whole module; everyone else only the parts their role and permission set reach (Operations decides the rest server-side)
  const items = staff ? ALL : ALL.filter((i) => i.key === 'ops' || i.key === 'scouting' || (['coach', 'staff', 'auditor'].includes(role) && ['safety', 'wellbeing'].includes(i.key)) || (['coach', 'staff', 'auditor'].includes(role) && i.key === 'curriculum') || (role === 'coach' && ['progress', 'academics'].includes(i.key)) || (role === 'staff' && i.key === 'academics') || (role === 'finance' && ['billing', 'partners'].includes(i.key)));
  const [tab, setTab] = useState(focus?.tab ?? (staff ? 'home' : role === 'coach' ? 'progress' : 'ops'));   // focus: open on a given tab / application (from the Command Centre)
  const [openApp, setOpenApp] = useState(focus?.open ?? null);
  const { tablet } = useLayout();
  const dash = useLoad(() => (staff ? api.get(`/organisations/${o.id}/academy/dashboard`) : Promise.resolve(null)), [o.id, staff]);
  const a = dash.data?.outstanding_actions;
  const badge = a ? { admissions: a.applications_to_review + a.offers_expiring + a.follow_ups_due } : {};
  const P = { o, role, archived, toast };
  const goTo = (key, id) => { setTab(key); if (key === 'admissions' && id) setOpenApp(id); };
  const openApplication = (id) => { setOpenApp(id); setTab('admissions'); };
  const body = !items.some((i) => i.key === tab) ? <Empty emoji="🔒" title="Not available for your role" /> : tab === 'ops' ? <Operations {...P} /> : tab === 'safety' ? <SafetyDesk {...P} /> : tab === 'wellbeing' ? <WellbeingDesk {...P} /> : tab === 'academics' ? <Academics {...P} /> : tab === 'competition' ? <Competition {...P} /> : tab === 'home' ? <Home {...P} go={goTo} orgGo={orgGo} openApplication={openApplication} canMoney />
    : tab === 'admissions' ? <Admissions {...P} openId={openApp} setOpenId={setOpenApp} onOpenScouting={() => setTab('scouting')} /> : tab === 'scouting' ? <Scouting {...P} onOpenApplication={openApplication} focus={focus?.tab === 'scouting' ? focus : null} /> : tab === 'programmes' ? <Programmes {...P} onOpenApplication={openApplication} />
    : tab === 'families' ? <Families {...P} onOpenApplication={openApplication} /> : tab === 'agreements' ? <Agreements {...P} /> : tab === 'billing' ? <Finance {...P} /> : tab === 'progress' ? <Progress {...P} /> : tab === 'curriculum' ? <Curriculum {...P} focus={focus?.tab === 'curriculum' ? focus : null} /> : tab === 'partners' ? <Partners {...P} />
    : tab === 'announce' ? <Announcements {...P} /> : tab === 'study' ? <StudyDesk {...P} /> : <Settings {...P} />;
  return (
    <View style={{ flexDirection: tablet ? 'row' : 'column', gap: tablet ? 20 : 0, marginTop: 10, alignItems: 'flex-start' }}>
      <ModuleNav items={items} value={tab} onChange={(k) => setTab(k)} badge={badge} />
      <View style={{ flex: tablet ? 1 : undefined, width: tablet ? undefined : '100%', minWidth: 0, marginTop: tablet ? 0 : 12 }}>{body}</View>
    </View>
  );
}

// The words of the wellbeing & development screens (#795): every label is a t() key written out in full so the translation tooling can see it.
import { t } from '../i18n';
import { locale } from '../locale';

export const SCOPE_LIST = ['tracks', 'mentoring', 'checkins', 'goals', 'guardian_updates', 'referrals'];
export const TOPIC_LIST = ['training_load_and_rest', 'school_and_study', 'sleep_and_routine', 'nutrition_and_hydration', 'team_and_friendships', 'travel_and_being_away_from_home', 'confidence_and_goals', 'leadership_and_values', 'other'];
export const CATEGORY_LIST = ['values', 'leadership', 'life_skills', 'nutrition_education', 'study_skills'];

export const opts = (list, fn) => list.map((value) => ({ value, label: fn(value) }));
export const scopeLabel = (s) => ({ tracks: t('wb.sc_tracks'), mentoring: t('wb.sc_mentoring'), checkins: t('wb.sc_checkins'), goals: t('wb.sc_goals'), guardian_updates: t('wb.sc_updates'), referrals: t('wb.sc_referrals') }[s] ?? s);
export const scopeHint = (s) => ({ tracks: t('wb.sh_tracks'), mentoring: t('wb.sh_mentoring'), checkins: t('wb.sh_checkins'), goals: t('wb.sh_goals'), guardian_updates: t('wb.sh_updates'), referrals: t('wb.sh_referrals') }[s] ?? '');
export const topicLabel = (s) => ({ training_load_and_rest: t('wb.tp_load'), school_and_study: t('wb.tp_school'), sleep_and_routine: t('wb.tp_sleep'), nutrition_and_hydration: t('wb.tp_nutrition'), team_and_friendships: t('wb.tp_team'), travel_and_being_away_from_home: t('wb.tp_travel'), confidence_and_goals: t('wb.tp_confidence'), leadership_and_values: t('wb.tp_leadership'), other: t('wb.tp_other') }[s] ?? s);
export const settingLabel = (s) => ({ academy_room: t('wb.se_room'), training_venue: t('wb.se_venue'), video_with_guardian_aware: t('wb.se_video'), phone_with_guardian_aware: t('wb.se_phone') }[s] ?? s);
export const outcomeLabel = (s) => ({ on_track: t('wb.oc_on_track'), follow_up: t('wb.oc_follow_up'), referral_suggested: t('wb.oc_referral'), concern_raised: t('wb.oc_concern') }[s] ?? s);
export const specialtyLabel = (s) => ({ sports_psychology: t('wb.sp_psychology'), counselling: t('wb.sp_counselling'), nutrition: t('wb.sp_nutrition'), sports_medicine: t('wb.sp_medicine'), physiotherapy: t('wb.sp_physio'), learning_support: t('wb.sp_learning'), other_specialist: t('wb.sp_other') }[s] ?? s);
export const reasonLabel = (s) => ({ performance_pressure: t('wb.rs_pressure'), load_and_recovery: t('wb.rs_load'), nutrition_support: t('wb.rs_nutrition'), school_balance: t('wb.rs_school'), general_wellbeing: t('wb.rs_general'), transition_support: t('wb.rs_transition'), other: t('wb.rs_other') }[s] ?? s);
export const statusLabel = (s) => ({
  scheduled: t('wb.st_scheduled'), completed: t('wb.st_completed'), missed: t('wb.st_missed'), cancelled: t('wb.st_cancelled'), active: t('wb.st_active'), paused: t('wb.st_paused'), ended: t('wb.st_ended'),
  proposed: t('wb.st_proposed'), agreed: t('wb.st_agreed'), achieved: t('wb.st_achieved'), dropped: t('wb.st_dropped'), consented: t('wb.st_consented'), handed_over: t('wb.st_handed'), declined: t('wb.st_declined'), withdrawn: t('wb.st_withdrawn'), closed: t('wb.st_closed'), enrolled: t('wb.st_enrolled'),
}[s] ?? (s ?? ''));
export const actionLabel = (k) => ({
  checkin_to_record: t('wb.ac_record'), follow_up_due: t('wb.ac_follow_up'), goal_review_due: t('wb.ac_goal_review'), goal_awaiting_family: t('wb.ac_goal_waiting'), referral_waiting: t('wb.ac_referral'), checkin_not_booked: t('wb.ac_not_booked'), mentor_review_due: t('wb.ac_mentor_review'), needs_mentor: t('wb.ac_needs_mentor'), consent_expiring: t('wb.ac_consent'),
}[k] ?? k);
export const catLabel = (s) => ({ values: t('wb.cat_values'), leadership: t('wb.cat_leadership'), life_skills: t('wb.cat_life'), nutrition_education: t('wb.cat_nutrition'), study_skills: t('wb.cat_study') }[s] ?? s);
export const deliveryLabel = (s) => ({ group: t('wb.dl_group'), one_to_one: t('wb.dl_one'), blended: t('wb.dl_blended') }[s] ?? s);
export const tplLabel = (s) => ({ track_progress: t('wb.tpl_track'), goal_outcome: t('wb.tpl_goal'), checkin_rhythm: t('wb.tpl_rhythm'), thank_you: t('wb.tpl_thanks'), review_invitation: t('wb.tpl_review') }[s] ?? s);
export const sevLabel = (s) => ({ low: t('wb.sev_low'), medium: t('wb.sev_medium'), high: t('wb.sev_high') }[s] ?? s);
export const skipLabel = (s) => ({ not_an_academy_athlete: t('wb.skip_not_athlete'), consent_missing: t('wb.skip_consent'), outside_age_band: t('wb.skip_age'), already_in_track: t('wb.skip_already') }[s] ?? s);
export const eventLabel = (k) => ({
  consent_granted: t('wb.ev_consent_granted'), consent_changed: t('wb.ev_consent_changed'), consent_revoked: t('wb.ev_consent_revoked'), consent_requested: t('wb.ev_consent_requested'), mentor_assigned: t('wb.ev_mentor_assigned'), mentor_changed: t('wb.ev_mentor_changed'),
  mentor_pause: t('wb.ev_mentor_paused'), mentor_resume: t('wb.ev_mentor_resumed'), mentor_end: t('wb.ev_mentor_ended'), mentor_adjust: t('wb.ev_mentor_adjusted'), checkin_scheduled: t('wb.ev_checkin_scheduled'), checkin_completed: t('wb.ev_checkin_completed'),
  checkin_rescheduled: t('wb.ev_checkin_rescheduled'), checkin_cancelled: t('wb.ev_checkin_cancelled'), checkin_missed: t('wb.ev_checkin_missed'), follow_up_done: t('wb.ev_follow_up_done'), goal_proposed: t('wb.ev_goal_proposed'), goal_agreed: t('wb.ev_goal_agreed'),
  goal_declined: t('wb.ev_goal_declined'), goal_start: t('wb.ev_goal_started'), goal_achieve: t('wb.ev_goal_achieved'), goal_pause: t('wb.ev_goal_paused'), goal_resume: t('wb.ev_goal_resumed'), goal_drop: t('wb.ev_goal_dropped'), goal_edit: t('wb.ev_goal_edited'), goal_schedule_review: t('wb.ev_goal_review_set'),
  referral_proposed: t('wb.ev_referral_proposed'), referral_consented: t('wb.ev_referral_consented'), referral_declined: t('wb.ev_referral_declined'), referral_withdrawn: t('wb.ev_referral_withdrawn'), referral_handed_over: t('wb.ev_referral_handed'), referral_closed: t('wb.ev_referral_closed'),
  track_enrolled: t('wb.ev_track_enrolled'), track_left: t('wb.ev_track_left'), module_done: t('wb.ev_module_done'), module_undone: t('wb.ev_module_undone'), complete: t('wb.ev_track_completed'), withdraw: t('wb.ev_track_withdrawn'), update_sent: t('wb.ev_update_sent'), record_viewed: t('wb.ev_viewed'),
}[k] ?? k);

export const dayText = (d) => { try { return new Date(String(d).length === 10 ? `${d}T12:00:00` : d).toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }); } catch { return ''; } };
export const dateTimeText = (d) => { try { return new Date(d).toLocaleString(locale, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }); } catch { return ''; } };

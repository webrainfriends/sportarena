// Speak instead of typing. A coach records comments in their own language (any of our 12), the server turns the recording into text, and the coach
// REVIEWS AND EDITS that text before anything is used: speech recognition can mishear names, numbers and sports terms, so nothing is inserted until
// the coach presses "Use". Two ways to use it:
//   mode "text"  the (reviewed) words go into one field: a criterion comment or one piece of written feedback; optionally translated first.
//   mode "form"  one spoken passage about the whole evaluation is sorted into the written feedback and the per-criterion comments, as a DRAFT
//                (AI) that is flagged for review and cannot be shared with the athlete until the coach confirms it.
// The audio is sent for transcription only for this request and is not stored. Recording: web MediaRecorder / expo-audio (iOS, iPadOS, Android).
import React, { useState } from 'react';
import { View } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { useSession } from '../session';
import { Btn, Chip, Field, Loading, Sheet, T } from '../ui';
import { MenuField } from '../menu-field';
import { VoiceRecorderSheet } from '../voice-note';
import { language, LANGUAGES, t } from '../i18n';
import { explain } from '../access';
import { c } from '../theme';
const mic = (s) => `🎙️ ${s}`;

const RTL = new Set(LANGUAGES.filter((l) => l.rtl).map((l) => l.code));
const langOptions = [{ value: 'auto', label: t('dic.auto') }, ...LANGUAGES.map((l) => ({ value: l.code, label: l.name }))];

/** @param {{ mode: 'text'|'form', evaluationId?: string, onUse: (r: any) => void, onClose: () => void, title?: string }} p */
export function DictationSheet({ mode, evaluationId, onUse, onClose, title }) {
  const { toast } = useSession();
  const opts = useLoad(() => api.get('/coaching/capture-options'), []);
  const vn = opts.data?.voice_note;
  const [lang, setLang] = useState(language);
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState(null);
  const [heard, setHeard] = useState(null);       // the language the service reports (when it does)
  const [to, setTo] = useState(language === 'en' ? 'hi' : 'en');
  const [trans, setTrans] = useState(null);       // a translation of the reviewed text
  const [writeIn, setWriteIn] = useState('same');
  const rtl = (code) => RTL.has(code);

  const transcribe = async ({ blob }) => {
    setBusy(true);
    try { const r = await api.postRaw(`/coaching/voice-note?language=${encodeURIComponent(lang)}`, blob); setText(r.transcript); setHeard(r.language ?? lang); setTrans(null); }
    catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const translate = async () => {
    setBusy(true);
    try { setTrans((await api.post('/coaching/translate', { text, from: heard && heard !== 'auto' ? heard : undefined, to })).text); }
    catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const fill = async () => {
    setBusy(true);
    try {
      const r = await api.post(`/coaching/evaluations/${evaluationId}/dictation`, { transcript: text, language: heard && heard !== 'auto' ? heard : undefined, write_in: writeIn === 'same' ? undefined : writeIn });
      if (r.empty) { toast(t('dic.empty_draft')); return; }
      onUse(r); onClose();
    } catch (e) { toast(explain(e)); } finally { setBusy(false); }
  };
  const aiOk = !!vn?.translate_available;

  return (
    <>
      <Sheet visible onClose={onClose} title={title ?? (mode === 'form' ? t('dic.form_title') : t('dic.title'))}>
        {!opts.data ? <Loading /> : !vn?.available ? <T size={13} color={c.mute}>{t('dic.unavailable')}</T> : (
          <View style={{ gap: 12 }}>
            {mode === 'form' ? <T size={13} color={c.mute}>{t('dic.form_note')}</T> : null}
            {text == null ? (
              <>
                <MenuField label={t('dic.language')} value={lang} onChange={setLang} options={langOptions} title={t('dic.language')} />
                <Btn title={mic(t('dic.start'))} loading={busy} onPress={() => setRecording(true)} accessibilityLabel={t('dic.start')} />
                {busy ? <T size={13} color={c.mute}>{t('dic.transcribing')}</T> : null}
                <T size={12} color={c.mute}>{vn.note}</T>
              </>
            ) : (
              <>
                <View style={{ padding: 10, borderRadius: 12, backgroundColor: c.sunSoft }}><T size={12} weight="700">{t('dic.review_note')}</T></View>
                <Field label={t('dic.review')} value={text} onChangeText={(v) => { setText(v); setTrans(null); }} multiline minHeight={140} maxLength={mode === 'form' ? 6000 : 2000} rtl={rtl(heard)} />
                {mode === 'text' ? (
                  <>
                    {aiOk ? (
                      <View style={{ gap: 8 }}>
                        <MenuField label={t('dic.translate_to')} value={to} onChange={(v) => { setTo(v); setTrans(null); }} options={LANGUAGES.filter((l) => l.code !== heard).map((l) => ({ value: l.code, label: l.name }))} title={t('dic.translate_to')} />
                        <Btn small title={t('dic.translate')} color={c.paper} ink={c.ink} loading={busy} disabled={!text.trim()} onPress={translate} />
                      </View>
                    ) : <T size={12} color={c.mute}>{t('dic.translate_off')}</T>}
                    {trans != null ? (
                      <View style={{ gap: 8 }}>
                        <Field label={t('dic.translation')} value={trans} onChangeText={setTrans} multiline minHeight={110} maxLength={3000} rtl={rtl(to)} />
                        <View style={{ flexDirection: 'row', gap: 8, flexWrap: 'wrap' }}>
                          <Btn small title={t('dic.use_original')} color={c.paper} ink={c.ink} disabled={!text.trim()} onPress={() => { onUse(text.trim()); onClose(); }} />
                          <Btn small title={t('dic.use_translation')} disabled={!trans.trim()} onPress={() => { onUse(trans.trim()); onClose(); }} />
                        </View>
                      </View>
                    ) : <Btn title={t('dic.use_text')} disabled={!text.trim()} onPress={() => { onUse(text.trim()); onClose(); }} accessibilityLabel={t('dic.use_text')} />}
                  </>
                ) : aiOk ? (
                  <>
                    <MenuField label={t('dic.write_in')} value={writeIn} onChange={setWriteIn} options={[{ value: 'same', label: t('dic.same_lang') }, ...LANGUAGES.map((l) => ({ value: l.code, label: l.name }))]} title={t('dic.write_in')} />
                    <Btn title={t('dic.fill_form')} loading={busy} disabled={text.trim().length < 3} onPress={fill} accessibilityLabel={t('dic.fill_form')} />
                  </>
                ) : <T size={13} color={c.mute}>{t('dic.ai_needed')}</T>}
                <Btn small title={t('dic.record_again')} color={c.paper} ink={c.ink} onPress={() => { setText(null); setTrans(null); }} />
              </>
            )}
          </View>
        )}
      </Sheet>
      {recording ? <VoiceRecorderSheet onClose={() => setRecording(false)} onDone={async (f) => { setRecording(false); await transcribe(f); }} /> : null}
    </>
  );
}

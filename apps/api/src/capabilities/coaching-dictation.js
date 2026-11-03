// Speaking instead of typing: a coach records comments in their own language (POST /coaching/voice-note turns the recording into text to review), and
// these two capabilities help turn that text into an evaluation. Both only PROPOSE: nothing is saved, and a draft that came from AI carries the same
// review gate as any other AI-drafted feedback (it cannot be shared with the athlete until the coach confirms they have read and edited it).
//  * translate_coaching_text: faithful translation between our 12 languages, so a comment spoken in Tamil can be read by an English-speaking athlete.
//  * draft_evaluation_from_dictation: one spoken passage becomes the written feedback and the per-criterion comments of one evaluation.
// The model sees the words and the sheet's criteria only: the athlete's name is replaced before anything is sent, and nothing is stored but the audit entry.
import { z } from 'zod';
import { cap, id } from '../registry.js';
import { one } from '../db.js';
import { AppError, notFound } from '../errors.js';
import { audit } from '../helpers.js';
import { aiConfigured, askJson, ask, quoteData, AI_RULES } from '../ai.js';
import { LANGUAGE_CODES } from '../comms-catalogue.js';

const TAG = 'Coaching dictation';
const COACH = ['coach'];
const NAME = { en: 'English', hi: 'Hindi', mr: 'Marathi', ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada', bn: 'Bengali', or: 'Odia', si: 'Sinhala', ur: 'Urdu', id: 'Bahasa Indonesia' };
const lang = z.enum(LANGUAGE_CODES);
const notAvailable = () => new AppError(501, 'not_available', 'AI is not set up on this server. Type the text in the language you want.');

cap({
  name: 'translate_coaching_text', method: 'POST', path: '/coaching/translate', tag: TAG, auth: COACH,
  summary: 'Translate a short piece of your own coaching text (for example a spoken comment you have just reviewed) into one of our 12 languages, faithfully: no additions, no softening, names and numbers unchanged. It only returns the translation; nothing is saved. Needs AI to be configured on the server (otherwise 501).',
  input: z.object({ text: z.string().trim().min(1).max(3000), from: lang.optional(), to: lang }),
  async handler({ user }, i) {
    if (!aiConfigured()) throw notAvailable();
    if (i.from === i.to) return { text: i.text, from: i.from, to: i.to, unchanged: true };
    const out = await ask({
      system: `You are a careful translator for a sports coach. ${AI_RULES} Translate the text${i.from ? ` from ${NAME[i.from]}` : ''} into ${NAME[i.to]}. Keep the meaning, tone, names, numbers and any sports terms exactly; add nothing, remove nothing, do not explain. Reply with the translation only.`,
      user: `<data>${quoteData(i.text, 3000)}</data>`, maxTokens: 1200,
    });
    if (!out) throw new AppError(502, 'translation_failed', 'The text could not be translated right now. Try again, or type it in the language you want.');
    await audit(null, user.id, 'coaching_translate', 'users', user.id);
    return { text: out.trim(), from: i.from ?? null, to: i.to };
  },
});

const draftSchema = z.object({
  strengths: z.string().max(1500).optional(), development: z.string().max(1500).optional(), cues: z.string().max(1500).optional(), next_steps: z.string().max(1500).optional(),
  comments: z.array(z.object({ key: z.string().max(40), comment: z.string().max(800) })).max(30).default([]),
});

/** The athlete's name is the one personal detail a coach is likely to say out loud: remove it (and any part of it) before the words go to a model. */
const scrubName = (text, fullName) => String(fullName ?? '').split(/\s+/).filter((p) => p.length >= 3).reduce((t, p) => t.replace(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'the athlete'), text);

cap({
  name: 'draft_evaluation_from_dictation', method: 'POST', path: '/coaching/evaluations/:id/dictation', tag: TAG, auth: COACH,
  summary: 'Turn what you said about an athlete (a reviewed transcript, in any of our 12 languages) into a draft of this evaluation\'s written feedback (strengths, development, cues, next steps) and a comment per criterion of its sheet. Only your words are used: nothing is invented, and criteria you did not talk about get no comment. By default it writes in the language you spoke; set write_in to another language to get the feedback in that one (for example English for the athlete). It returns a PROPOSAL to review and edit; it saves nothing, and the draft is flagged ai_drafted so it must be confirmed (confirm_reviewed) before the evaluation is shared. Needs AI configured (otherwise 501); the athlete\'s name is removed before anything is sent.',
  input: z.object({ id, transcript: z.string().trim().min(3).max(6000), language: lang.optional().describe('the language you spoke'), write_in: lang.optional().describe('the language to write the feedback in; defaults to the one you spoke') }),
  async handler({ user }, i) {
    const ev = await one('SELECT e.id, e.rubric_id, e.rubric_version, e.coach_id, e.closed_at, u.display_name FROM coaching_evaluations e JOIN users u ON u.id=e.athlete_id WHERE e.id=$1 AND e.coach_id=$2', [i.id, user.id]);
    if (!ev) throw notFound('Evaluation');
    if (!aiConfigured()) throw notAvailable();
    const dims = (await one('SELECT dimensions FROM coaching_rubric_versions WHERE rubric_id=$1 AND version=$2', [ev.rubric_id, ev.rubric_version]))?.dimensions ?? [];
    const keys = new Set(dims.map((d) => d.key));
    const writeIn = i.write_in ?? i.language ?? null;
    const criteria = dims.map((d) => ({ key: d.key, name: quoteData(d.name, 60), what_it_means: quoteData(d.description ?? '', 160) }));
    const out = await askJson({
      system: `You help a sports coach write an evaluation of one athlete from what the coach said out loud. ${AI_RULES} Use ONLY what the coach said: do not add praise, advice or facts they did not mention, and do not give medical advice. Sort their words into strengths, development areas, coaching cues and next steps (leave a field out if they said nothing for it), and add a short comment for a criterion ONLY when they spoke about it, using the criterion's exact key. Write in ${writeIn ? NAME[writeIn] : 'the same language the coach spoke'}. Refer to the athlete as "the athlete" or by pronoun, never by name. Criteria: ${JSON.stringify(criteria)}`,
      user: `<data>${quoteData(scrubName(i.transcript, ev.display_name), 6000)}</data>`, schema: draftSchema,
      shape: '{"strengths"?: string, "development"?: string, "cues"?: string, "next_steps"?: string, "comments": [{"key": string, "comment": string}]}', maxTokens: 1500,
    });
    if (!out) throw new AppError(502, 'draft_failed', 'A draft could not be made from that recording right now. You can put the text into the fields yourself.');
    await audit(null, user.id, 'ai_evaluation_dictation', 'coaching_evaluations', ev.id);
    const comments = {};
    for (const c of out.comments) if (keys.has(c.key) && c.comment.trim()) comments[c.key] = c.comment.trim();   // a key the sheet does not have is dropped, never guessed
    const narrative = Object.fromEntries(['strengths', 'development', 'cues', 'next_steps'].map((k) => [k, out[k]?.trim()]).filter(([, v]) => v));
    return { evaluation_id: ev.id, narrative: { ...narrative, ai_drafted: true }, comments, empty: !Object.keys(narrative).length && !Object.keys(comments).length, saved: false, note: 'Read and edit this, then save it. It is marked as an AI draft and needs your confirmation before it is shared.' };
  },
});

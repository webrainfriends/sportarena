// Short voice notes for the team chat, on the web, iOS, iPadOS and Android.
//  * Recording: the browser's MediaRecorder on the web; expo-audio on phones and tablets. Capped at 2 minutes. Nothing is sent until the person presses Send.
//  * Playing: a protected file (it needs the sign-in header), so it is downloaded first, then played from a local URL / file.
import React, { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { AudioModule, RecordingPresets, createAudioPlayer, setAudioModeAsync, useAudioRecorder } from 'expo-audio';
import { api } from './api';
import { useSession } from './session';
import { Btn, Sheet, T } from './ui';
import { c } from './theme';

export const MAX_SECONDS = 120;
const mmss = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

/** Record a note, listen to it, then send or discard. onDone({ blob, seconds, name }). */
export function VoiceRecorderSheet({ onClose, onDone }) {
  const { toast } = useSession();
  const [phase, setPhase] = useState('idle');   // idle | recording | review
  const [secs, setSecs] = useState(0);
  const [take, setTake] = useState(null);
  const tick = useRef(null);
  const web = useRef({});
  const native = useAudioRecorder(RecordingPresets.HIGH_QUALITY);

  useEffect(() => () => { clearInterval(tick.current); web.current.stream?.getTracks().forEach((t) => t.stop()); }, []);

  const start = async () => {
    try {
      if (Platform.OS === 'web') {
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record. Attach an audio file instead.');
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const rec = new MediaRecorder(stream);
        const parts = [];
        rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
        rec.onstop = () => { stream.getTracks().forEach((t) => t.stop()); setTake({ blob: new Blob(parts, { type: rec.mimeType || 'audio/webm' }) }); };
        web.current = { rec, stream };
        rec.start();
      } else {
        const perm = await AudioModule.requestRecordingPermissionsAsync();
        if (!perm.granted) throw new Error('Allow the microphone in Settings to record a voice note.');
        await setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
        await native.prepareToRecordAsync();
        native.record();
      }
      setSecs(0); setPhase('recording');
      tick.current = setInterval(() => setSecs((s) => { if (s + 1 >= MAX_SECONDS) stop(); return s + 1; }), 1000);
    } catch (e) { toast(e.message); }
  };
  const stop = async () => {
    clearInterval(tick.current);
    try {
      if (Platform.OS === 'web') web.current.rec?.stop();
      else { await native.stop(); setTake({ uri: native.uri }); }
      setPhase('review');
    } catch (e) { toast(e.message); setPhase('idle'); }
  };
  const send = async () => {
    try {
      const blob = take.blob ?? await (await fetch(take.uri)).blob();
      await onDone({ blob, seconds: Math.max(1, Math.min(MAX_SECONDS, secs)), name: 'Voice note' });
      onClose();
    } catch (e) { toast(e.message); }
  };

  return (
    <Sheet visible onClose={onClose} title="Voice note">
      <View style={{ alignItems: 'center', gap: 14, paddingVertical: 8 }}>
        <T size={44} accessibilityLabel={`Recording length ${mmss(secs)}`} weight="800">{mmss(secs)}</T>
        {phase === 'idle' ? <Btn title="🎙️ Start recording" onPress={start} accessibilityLabel="Start recording" /> : null}
        {phase === 'recording' ? <Btn title="⏹ Stop" color={c.red} onPress={stop} accessibilityLabel="Stop recording" /> : null}
        {phase === 'review' && take ? (
          <View style={{ gap: 10, alignItems: 'center', alignSelf: 'stretch' }}>
            <T color={c.mute}>Recorded {mmss(secs)}. Nothing is sent until you press Send.</T>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Btn title="Record again" color={c.paper} ink={c.ink} onPress={() => { setTake(null); setSecs(0); setPhase('idle'); }} />
              <Btn title="Send" onPress={send} accessibilityLabel="Send voice note" />
            </View>
          </View>
        ) : null}
        <T size={12} color={c.mute}>Up to {MAX_SECONDS / 60} minutes · only your team can hear it</T>
      </View>
    </Sheet>
  );
}

/** Play a voice note from the chat. The file is fetched with the sign-in header, then played locally. */
export function VoicePlayer({ media }) {
  const { toast } = useSession();
  const [state, setState] = useState('idle');   // idle | loading | playing
  const player = useRef(null);
  useEffect(() => () => { player.current?.pause?.(); player.current?.remove?.(); player.current?.src && URL.revokeObjectURL?.(player.current.src); }, []);

  const toggle = async () => {
    try {
      if (state === 'playing') { player.current?.pause(); setState('idle'); return; }
      if (!player.current) {
        setState('loading');
        const blob = await api.download(media.url.replace('/api/v1', ''));
        if (Platform.OS === 'web') {
          const a = new Audio(URL.createObjectURL(blob));
          a.onended = () => setState('idle');
          player.current = a;
        } else {
          const { File, Paths } = await import('expo-file-system');
          const ext = media.content_type?.includes('mp4') ? 'm4a' : media.content_type?.includes('mpeg') ? 'mp3' : 'caf';
          const file = new File(Paths.cache, `voice-${media.id}.${ext}`);
          file.create({ overwrite: true });
          file.write(new Uint8Array(await new Response(blob).arrayBuffer()));
          const p = createAudioPlayer(file.uri);
          p.addListener?.('playbackStatusUpdate', (s) => { if (s.didJustFinish) setState('idle'); });
          player.current = p;
        }
      }
      await player.current.play();
      setState('playing');
    } catch (e) { setState('idle'); toast(e.message || 'Could not play this voice note'); }
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 44 }}>
      <Btn small title={state === 'playing' ? '⏸' : state === 'loading' ? '…' : '▶'} onPress={toggle} accessibilityLabel={state === 'playing' ? 'Pause voice note' : 'Play voice note'} />
      <T weight="700">🎙️ Voice note · {mmss(media.seconds ?? 0)}</T>
    </View>
  );
}

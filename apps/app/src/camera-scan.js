// The camera QR reader, shared by every scanner in the app (event gate, academy / team / venue check-in). Codes can also be typed or pasted:
// a USB or Bluetooth scanner, and an RFID/NFC reader that acts as a keyboard, type into the field next to it.
import React, { useEffect, useRef } from 'react';
import { Pressable, View } from 'react-native';
import { Btn, Card, T } from './ui';

let CameraMod = null;
try { CameraMod = require('expo-camera'); } catch { CameraMod = null; }

/** Camera reader: scans QR codes continuously; a code seen again within 3 seconds is ignored. */
export function CameraScan({ onCode, onClose }) {
  const [perm, ask] = CameraMod.useCameraPermissions();
  const last = useRef({ code: null, at: 0 });
  useEffect(() => { if (perm && !perm.granted && perm.canAskAgain) ask(); }, [perm?.granted]);
  if (!perm?.granted) return <Card><T>Camera access is needed to scan. {perm?.canAskAgain === false ? 'Allow it in Settings, or type the code below.' : ''}</T><Btn small title="Allow camera" onPress={ask} style={{ marginTop: 8, alignSelf: 'flex-start' }} /></Card>;
  const { CameraView } = CameraMod;
  return (
    <View style={{ borderRadius: 24, overflow: 'hidden', height: 280, backgroundColor: '#000' }}>
      <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} accessibilityLabel="Camera view for scanning a QR code"
        onBarcodeScanned={({ data }) => { const now = Date.now(); if (data === last.current.code && now - last.current.at < 3000) return; last.current = { code: data, at: now }; onCode(data); }} />
      <Pressable onPress={onClose} accessibilityRole="button" accessibilityLabel="Close camera" style={{ position: 'absolute', top: 10, right: 10, minWidth: 44, minHeight: 44, borderRadius: 22, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}><T color="#fff" weight="800">✕</T></Pressable>
    </View>
  );
}


export const hasCamera = !!CameraMod;

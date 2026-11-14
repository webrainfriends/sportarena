/**
 * RichStepEditor — MS Word-like rich text editor for drill content steps.
 *
 * Web: contentEditable div with execCommand toolbar (bold, italic, underline,
 *      strike, H1/H2, bullets, numbers, blockquote, align, undo/redo).
 * Native: multiline TextInput with a toolbar that wraps the current selection
 *         (or cursor position) in HTML tags, stored as the same HTML string.
 *
 * Data format: HTML string stored in step.text.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, ScrollView, TextInput, View } from 'react-native';
import { T } from './ui';
import { c, fam, r } from './theme';
import { t } from './i18n';

// ─── Toolbar definition ───────────────────────────────────────────────────────

const GROUPS = [
  [
    { id: 'undo', label: '↩', title: 'Undo', cmd: 'undo' },
    { id: 'redo', label: '↪', title: 'Redo', cmd: 'redo' },
  ],
  [
    { id: 'bold', label: 'B', title: 'Bold', cmd: 'bold', style: { fontWeight: '700' } },
    { id: 'italic', label: 'I', title: 'Italic', cmd: 'italic', style: { fontStyle: 'italic' } },
    { id: 'underline', label: 'U', title: 'Underline', cmd: 'underline', style: { textDecorationLine: 'underline' } },
    { id: 'strikeThrough', label: 'S', title: 'Strikethrough', cmd: 'strikeThrough', style: { textDecorationLine: 'line-through' } },
  ],
  [
    { id: 'h1', label: 'H1', title: 'Heading 1', cmd: 'formatBlock', val: 'h1' },
    { id: 'h2', label: 'H2', title: 'Heading 2', cmd: 'formatBlock', val: 'h2' },
    { id: 'h3', label: 'H3', title: 'Heading 3', cmd: 'formatBlock', val: 'h3' },
    { id: 'p', label: 'P', title: 'Paragraph', cmd: 'formatBlock', val: 'p' },
  ],
  [
    { id: 'ul', label: '•≡', title: 'Bullet list', cmd: 'insertUnorderedList' },
    { id: 'ol', label: '1≡', title: 'Numbered list', cmd: 'insertOrderedList' },
    { id: 'blockquote', label: '❝', title: 'Blockquote', cmd: 'formatBlock', val: 'blockquote' },
  ],
  [
    { id: 'justifyLeft', label: '⬜', title: 'Align left', cmd: 'justifyLeft' },
    { id: 'justifyCenter', label: '▬', title: 'Align centre', cmd: 'justifyCenter' },
    { id: 'justifyRight', label: '▪', title: 'Align right', cmd: 'justifyRight' },
  ],
];

// ─── Web implementation ───────────────────────────────────────────────────────

function WebRichEditor({ value, onChange, placeholder }) {
  const editorRef = useRef(null);
  const skipNextSync = useRef(false);
  const [activeStates, setActiveStates] = useState({});

  // Keep DOM in sync when value changes from outside (e.g. form reset)
  useEffect(() => {
    const el = editorRef.current;
    if (!el || skipNextSync.current) { skipNextSync.current = false; return; }
    if (el.innerHTML !== (value || '')) el.innerHTML = value || '';
  }, [value]);

  const refreshActive = useCallback(() => {
    const states = {};
    GROUPS.flat().forEach(({ id, cmd, val }) => {
      try {
        states[id] = document.queryCommandState(cmd);
        if (val && cmd === 'formatBlock') {
          states[id] = document.queryCommandValue(cmd) === val;
        }
      } catch { /* ignore */ }
    });
    setActiveStates(states);
  }, []);

  const exec = useCallback((cmd, val) => {
    editorRef.current?.focus();
    document.execCommand(cmd, false, val ?? null);
    skipNextSync.current = true;
    onChange(editorRef.current?.innerHTML ?? '');
    refreshActive();
  }, [onChange, refreshActive]);

  const handleInput = useCallback(() => {
    skipNextSync.current = true;
    onChange(editorRef.current?.innerHTML ?? '');
    refreshActive();
  }, [onChange, refreshActive]);

  return (
    <View style={{ borderRadius: r.input, borderWidth: 1, borderColor: c.line, overflow: 'hidden', backgroundColor: c.paper }}>
      {/* Toolbar */}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 2, padding: 6, borderBottomWidth: 1, borderBottomColor: c.line, backgroundColor: c.bg }}>
        {GROUPS.map((group, gi) => (
          <React.Fragment key={gi}>
            {gi > 0 && <View style={{ width: 1, backgroundColor: c.line, marginHorizontal: 3, alignSelf: 'stretch' }} />}
            {group.map((btn) => (
              <Pressable
                key={btn.id}
                onPress={() => exec(btn.cmd, btn.val)}
                accessibilityRole="button"
                accessibilityLabel={btn.title}
                style={({ pressed }) => ({
                  paddingHorizontal: 7, paddingVertical: 5, borderRadius: 6, minWidth: 28,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: activeStates[btn.id] ? c.pinkSoft : pressed ? c.violetSoft : 'transparent',
                })}
              >
                <T size={12} weight="600" color={activeStates[btn.id] ? c.pink : c.ink} style={[btn.style, { lineHeight: 16 }]}>{btn.label}</T>
              </Pressable>
            ))}
          </React.Fragment>
        ))}
      </View>
      {/* Editor area — rendered as a plain div via dangerouslySetInnerHTML on web */}
      {/* eslint-disable-next-line react-native/no-inline-styles */}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onKeyUp={refreshActive}
        onMouseUp={refreshActive}
        onFocus={refreshActive}
        data-placeholder={placeholder}
        dangerouslySetInnerHTML={{ __html: value || '' }}
        style={{
          minHeight: 120, padding: 12, outline: 'none',
          color: c.ink, backgroundColor: c.paper,
          fontFamily: '"Inter", "SF Pro Display", "Segoe UI", system-ui, -apple-system, sans-serif',
          fontSize: 14, lineHeight: '1.6',
          wordBreak: 'break-word',
        }}
      />
      <style>{`
        [data-placeholder]:empty::before {
          content: attr(data-placeholder);
          color: ${c.mute};
          pointer-events: none;
        }
        [contenteditable] h1 { font-size: 20px; font-weight: 700; margin: 8px 0 4px; }
        [contenteditable] h2 { font-size: 17px; font-weight: 700; margin: 6px 0 4px; }
        [contenteditable] h3 { font-size: 15px; font-weight: 600; margin: 4px 0 2px; }
        [contenteditable] ul { padding-left: 20px; }
        [contenteditable] ol { padding-left: 20px; }
        [contenteditable] li { margin: 2px 0; }
        [contenteditable] blockquote {
          border-left: 3px solid ${c.pink}; padding-left: 10px;
          margin: 4px 0; color: ${c.mute}; font-style: italic;
        }
        [contenteditable] p { margin: 2px 0; }
        [contenteditable] b, [contenteditable] strong { font-weight: 700; }
        [contenteditable] i, [contenteditable] em { font-style: italic; }
        [contenteditable] u { text-decoration: underline; }
        [contenteditable] s, [contenteditable] strike { text-decoration: line-through; }
      `}</style>
    </View>
  );
}

// ─── Native implementation ────────────────────────────────────────────────────
// Wraps the current selection (or inserts at cursor) with HTML inline tags.
// Block-level items (headings, lists) are inserted as prefix markers.

const NATIVE_TOOLS = [
  [
    { id: 'bold', label: 'B', title: 'Bold', wrap: ['<b>', '</b>'], style: { fontWeight: '700' } },
    { id: 'italic', label: 'I', title: 'Italic', wrap: ['<i>', '</i>'], style: { fontStyle: 'italic' } },
    { id: 'underline', label: 'U', title: 'Underline', wrap: ['<u>', '</u>'], style: { textDecorationLine: 'underline' } },
    { id: 'strike', label: 'S', title: 'Strikethrough', wrap: ['<s>', '</s>'], style: { textDecorationLine: 'line-through' } },
  ],
  [
    { id: 'h1', label: 'H1', title: 'Heading 1', prefix: '# ' },
    { id: 'h2', label: 'H2', title: 'Heading 2', prefix: '## ' },
    { id: 'ul', label: '•', title: 'Bullet', prefix: '• ' },
    { id: 'ol', label: '1.', title: 'Numbered', prefix: '1. ' },
  ],
];

function NativeRichEditor({ value, onChange, placeholder }) {
  const inputRef = useRef(null);
  const [sel, setSel] = useState({ start: 0, end: 0 });

  const applyTool = useCallback((tool) => {
    const text = value ?? '';
    const { start, end } = sel;

    if (tool.wrap) {
      const [open, close] = tool.wrap;
      const before = text.slice(0, start);
      const selected = text.slice(start, end);
      const after = text.slice(end);
      const newText = before + open + selected + close + after;
      onChange(newText);
      // restore focus
      setTimeout(() => inputRef.current?.focus(), 50);
    } else if (tool.prefix) {
      // find start of current line
      const lineStart = text.lastIndexOf('\n', start - 1) + 1;
      const before = text.slice(0, lineStart);
      const after = text.slice(lineStart);
      onChange(before + tool.prefix + after);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [value, sel, onChange]);

  return (
    <View style={{ borderRadius: r.input, borderWidth: 1, borderColor: c.line, overflow: 'hidden', backgroundColor: c.paper }}>
      {/* Toolbar */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false}
        style={{ backgroundColor: c.bg, borderBottomWidth: 1, borderBottomColor: c.line }}
        contentContainerStyle={{ flexDirection: 'row', gap: 2, padding: 6, alignItems: 'center' }}>
        {NATIVE_TOOLS.map((group, gi) => (
          <React.Fragment key={gi}>
            {gi > 0 && <View style={{ width: 1, backgroundColor: c.line, marginHorizontal: 3, alignSelf: 'stretch', minHeight: 20 }} />}
            {group.map((btn) => (
              <Pressable
                key={btn.id}
                onPress={() => applyTool(btn)}
                accessibilityRole="button"
                accessibilityLabel={btn.title}
                style={({ pressed }) => ({
                  paddingHorizontal: 8, paddingVertical: 6, borderRadius: 6, minWidth: 30,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: pressed ? c.pinkSoft : 'transparent',
                })}
              >
                <T size={12} weight="600" color={c.ink} style={btn.style}>{btn.label}</T>
              </Pressable>
            ))}
          </React.Fragment>
        ))}
      </ScrollView>
      {/* Input */}
      <TextInput
        ref={inputRef}
        value={value ?? ''}
        onChangeText={onChange}
        onSelectionChange={(e) => setSel(e.nativeEvent.selection)}
        placeholder={placeholder}
        placeholderTextColor={c.mute}
        multiline
        textAlignVertical="top"
        style={[fam, {
          minHeight: 120, padding: 12,
          color: c.ink, backgroundColor: c.paper,
          fontSize: 14, lineHeight: 22,
        }]}
      />
    </View>
  );
}

// ─── Public component ─────────────────────────────────────────────────────────

/**
 * RichStepEditor
 * Props:
 *   value       {string}   HTML content string
 *   onChange    {fn}       called with updated HTML string
 *   placeholder {string}   placeholder text shown when empty
 */
export function RichStepEditor({ value, onChange, placeholder }) {
  if (Platform.OS === 'web') {
    return <WebRichEditor value={value} onChange={onChange} placeholder={placeholder} />;
  }
  return <NativeRichEditor value={value} onChange={onChange} placeholder={placeholder} />;
}

// ─── HTML renderer for display (native) ──────────────────────────────────────
// Minimal HTML-to-RN text renderer for displaying stored rich text in read-only view.
// Only handles tags that the editor produces.

const HTML_TAG_RE = /<(\/?)([a-z0-9]+)[^>]*>/gi;

/** Renders a stored HTML string as styled React Native <Text> nodes for read-only display. */
export function RichText({ html, size = 14, color }) {
  if (!html) return null;

  if (Platform.OS === 'web') {
    return (
      <div
        dangerouslySetInnerHTML={{ __html: html }}
        style={{
          color: color ?? c.ink, fontSize: size, lineHeight: '1.6',
          fontFamily: '"Inter", "SF Pro Display", "Segoe UI", system-ui, sans-serif',
          wordBreak: 'break-word',
        }}
      />
    );
  }

  // Native: strip HTML and show plain text with minimal styling
  const plain = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>|<\/h[1-3]>|<\/li>|<\/blockquote>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n').trim();

  return <T size={size} color={color ?? c.ink} style={{ lineHeight: 22 }}>{plain}</T>;
}

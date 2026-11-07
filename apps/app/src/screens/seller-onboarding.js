import React, { useState } from 'react';
import { ScrollView, View, StyleSheet, TouchableOpacity, Platform } from 'react-native';
import { api } from '../api';
import { useLoad } from '../hooks';
import { Btn, Card, Empty, ErrorBox, H1, Loading, Row, Screen, Section, T, Tag } from '../ui';
import { FormSheet } from '../form-sheet';
import { c, r, font } from '../theme';
import { t } from '../i18n';

const STEPS = [
  { key: 'account_added',    titleKey: 'seon.step_account_added',    doneKey: 'seon.step_done',     pendKey: 'seon.step_add_account' },
  { key: 'account_verified', titleKey: 'seon.step_account_verified', doneKey: 'seon.step_done',     pendKey: 'seon.step_pending_review' },
  { key: 'terms_accepted',   titleKey: 'seon.step_terms',            doneKey: 'seon.step_accepted', pendKey: 'seon.step_accept_terms' },
  { key: 'config_ok',        titleKey: 'seon.step_config',           doneKey: 'seon.step_done',     pendKey: 'seon.step_contact_support' },
];

export default function SellerOnboarding({ navigation }) {
  const [status, loading, err, reload] = useLoad(() => api.get('/me/seller-status'));
  const [acceptingCurrency, setAcceptingCurrency] = useState(null);
  const [agreed, setAgreed] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [acceptErr, setAcceptErr] = useState(null);

  const handleAcceptTerms = async (currency) => {
    if (!agreed) return;
    setAccepting(true);
    setAcceptErr(null);
    try {
      await api.post('/me/seller-terms', { currency, version: 'seller-terms-v1.0' });
      setAcceptingCurrency(null);
      setAgreed(false);
      reload();
    } catch (e) {
      setAcceptErr(e?.message ?? 'Could not accept terms');
    } finally {
      setAccepting(false);
    }
  };

  if (loading) return <Loading />;
  if (err) return <ErrorBox error={err} onRetry={reload} />;

  const { currencies = [], any_pending } = status ?? {};

  return (
    <Screen>
      <ScrollView contentContainerStyle={styles.scroll} accessibilityRole="main">
        <H1 accessibilityRole="header">{t('seon.title')}</H1>
        <T style={styles.sub}>{t('seon.subtitle')}</T>

        {!any_pending && currencies.length > 0 && (
          <Card style={[styles.allDoneCard]}>
            <T style={styles.allDoneText}>{t('seon.all_done')}</T>
          </Card>
        )}

        {currencies.length === 0 && (
          <Empty
            title={t('seon.no_currencies_title')}
            body={t('seon.no_currencies_body')}
            action={
              <Btn label={t('seon.add_account')} onPress={() => navigation?.navigate?.('Earnings')}
                accessibilityLabel={t('seon.add_account')} />
            }
          />
        )}

        {currencies.map((cur) => (
          <Card key={cur.currency} style={styles.card}>
            <Row style={styles.cardHeader}>
              <T style={styles.currency}>{cur.currency}</T>
              <Tag
                label={cur.all_done ? t('seon.payouts_enabled') : t('seon.payouts_pending')}
                color={cur.all_done ? c.lime : c.sun}
                bg={cur.all_done ? c.limeSoft : c.sunSoft}
                accessibilityLabel={cur.all_done ? t('seon.payouts_enabled') : t('seon.payouts_pending')}
              />
            </Row>

            {STEPS.map((step) => {
              const done = cur[step.key];
              return (
                <Row key={step.key} style={styles.stepRow} accessibilityLabel={`${t(step.titleKey)}: ${done ? t(step.doneKey) : t(step.pendKey)}`}>
                  <View style={[styles.dot, { backgroundColor: done ? c.lime : c.sun }]} />
                  <T style={styles.stepLabel}>{t(step.titleKey)}</T>
                  <Tag
                    label={done ? t(step.doneKey) : t(step.pendKey)}
                    color={done ? c.lime : c.sun}
                    bg={done ? c.limeSoft : c.sunSoft}
                  />
                </Row>
              );
            })}

            {!cur.account_added && (
              <Btn
                label={t('seon.add_account')}
                color={c.pink}
                style={styles.cta}
                onPress={() => navigation?.navigate?.('Earnings')}
                accessibilityLabel={t('seon.add_account')}
              />
            )}
            {cur.account_added && cur.account_verified && !cur.terms_accepted && (
              <Btn
                label={t('seon.review_terms')}
                color={c.pink}
                style={styles.cta}
                onPress={() => { setAcceptingCurrency(cur.currency); setAgreed(false); setAcceptErr(null); }}
                accessibilityLabel={t('seon.review_terms')}
              />
            )}
            {cur.instant_eligible && cur.all_done && (
              <Row style={styles.instantRow}>
                <T style={styles.instantLabel}>{t('seon.instant_eligible')}</T>
                <Tag label={`${cur.instant_fee_bp ? (cur.instant_fee_bp / 100).toFixed(2) + '%' : '–'} fee`} color={c.cyan} bg={c.cyanSoft} />
              </Row>
            )}
          </Card>
        ))}

        <Section title={t('seon.need_help')}>
          <T style={styles.helpText}>{t('seon.help_body')}</T>
        </Section>
      </ScrollView>

      {acceptingCurrency && (
        <FormSheet
          visible
          onClose={() => setAcceptingCurrency(null)}
          title={t('seon.terms_title')}
        >
          <T style={styles.termsBody}>{t('seon.terms_body')}</T>
          <TouchableOpacity
            style={styles.checkRow}
            onPress={() => setAgreed((v) => !v)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: agreed }}
            accessibilityLabel={t('seon.terms_agree')}
          >
            <View style={[styles.checkbox, agreed && { backgroundColor: c.pink, borderColor: c.pink }]}>
              {agreed && <T style={styles.checkMark}>✓</T>}
            </View>
            <T style={styles.checkLabel}>{t('seon.terms_agree')}</T>
          </TouchableOpacity>
          {acceptErr ? <T style={styles.errText}>{acceptErr}</T> : null}
          <Btn
            label={t('seon.terms_accept')}
            disabled={!agreed || accepting}
            loading={accepting}
            onPress={() => handleAcceptTerms(acceptingCurrency)}
            color={c.pink}
            style={styles.cta}
            accessibilityLabel={t('seon.terms_accept')}
          />
        </FormSheet>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  scroll: { padding: 20, gap: 16, paddingBottom: 40 },
  sub: { color: c.mute, marginBottom: 4 },
  allDoneCard: { backgroundColor: c.limeSoft, padding: 16, borderRadius: r.card },
  allDoneText: { ...font.bold, color: c.lime },
  card: { padding: 20, borderRadius: r.card, gap: 12 },
  cardHeader: { justifyContent: 'space-between', alignItems: 'center' },
  currency: { ...font.bold, fontSize: 18 },
  stepRow: { alignItems: 'center', gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  stepLabel: { flex: 1 },
  cta: { marginTop: 4 },
  instantRow: { alignItems: 'center', gap: 8, marginTop: 4 },
  instantLabel: { flex: 1, color: c.mute },
  helpText: { color: c.mute, lineHeight: 22 },
  termsBody: { color: c.mute, lineHeight: 22, marginBottom: 16 },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 16, minHeight: 44 },
  checkbox: { width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: c.line, alignItems: 'center', justifyContent: 'center', marginTop: 1 },
  checkMark: { color: c.on, fontSize: 13, ...font.bold },
  checkLabel: { flex: 1, lineHeight: 22 },
  errText: { color: c.red, marginBottom: 8 },
});

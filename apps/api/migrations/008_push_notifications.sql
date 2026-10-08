-- Push notifications: devices (Expo push tokens for the phone apps, Web Push subscriptions for browsers) and a push channel.
CREATE TABLE push_devices (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users,
  provider    text NOT NULL CHECK (provider IN ('expo','webpush')),
  platform    text NOT NULL CHECK (platform IN ('ios','android','web')),
  token       text NOT NULL,                       -- Expo push token, or the Web Push endpoint URL
  keys_enc    text,                                -- Web Push subscription keys {p256dh, auth}, encrypted
  label       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  disabled_at timestamptz,                         -- soft delete: unregistered by the user or rejected by the provider
  disabled_reason text,
  UNIQUE (provider, token)
);
CREATE INDEX push_devices_user ON push_devices (user_id) WHERE disabled_at IS NULL;

ALTER TABLE notification_prefs ADD COLUMN push boolean NOT NULL DEFAULT true;

ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_channel_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_channel_check CHECK (channel IN ('email','push'));

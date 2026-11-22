CREATE TABLE user_preferences (
  tenant_id uuid NOT NULL,
  object_id uuid NOT NULL,
  language text NOT NULL DEFAULT 'ja' CHECK (language IN ('ja', 'en')),
  theme text NOT NULL DEFAULT 'light' CHECK (theme IN ('light', 'dark')),
  PRIMARY KEY (tenant_id, object_id)
);

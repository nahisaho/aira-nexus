CREATE TABLE user_text_preferences (
  tenant_id uuid NOT NULL,
  object_id uuid NOT NULL,
  size text NOT NULL DEFAULT 'large' CHECK (size IN ('large', 'medium', 'small')),
  PRIMARY KEY (tenant_id, object_id)
);

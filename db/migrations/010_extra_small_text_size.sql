ALTER TABLE user_text_preferences
  DROP CONSTRAINT user_text_preferences_size_check,
  ADD CONSTRAINT user_text_preferences_size_check
    CHECK (size IN ('large', 'medium', 'small', 'extra-small'));

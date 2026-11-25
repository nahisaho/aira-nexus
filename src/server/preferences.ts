import type { Pool } from 'pg';
import type { Principal } from '../shared/contracts.js';
import {
  defaultPreferences,
  preferencesSchema,
  defaultTextSize,
  textSizeSchema,
} from '../shared/preferences.js';
import type { UserPreferences, TextSizePreference } from '../shared/preferences.js';

/** @id CODE-PREF-001 @implements REQ-PREF-001 REQ-PREF-002 */
export class PreferencesRepository {
  constructor(private readonly pool: Pool) {}
  async get(owner: Principal): Promise<UserPreferences> {
    const result = await this.pool.query<UserPreferences>(
      'SELECT language,theme FROM user_preferences WHERE tenant_id=$1 AND object_id=$2',
      [owner.tenantId, owner.objectId],
    );
    return result.rows[0] ? preferencesSchema.parse(result.rows[0]) : { ...defaultPreferences };
  }
  async patch(owner: Principal, changes: Partial<UserPreferences>): Promise<UserPreferences> {
    const result = await this.pool.query<UserPreferences>(
      `INSERT INTO user_preferences(tenant_id,object_id,language,theme)
       VALUES($1,$2,COALESCE($3,$5),COALESCE($4,$6))
       ON CONFLICT(tenant_id,object_id) DO UPDATE SET
       language=COALESCE($3,user_preferences.language),theme=COALESCE($4,user_preferences.theme)
       RETURNING language,theme`,
      [
        owner.tenantId,
        owner.objectId,
        changes.language ?? null,
        changes.theme ?? null,
        defaultPreferences.language,
        defaultPreferences.theme,
      ],
    );
    return preferencesSchema.parse(result.rows[0]);
  }

  /** @id CODE-FONT-002 @implements REQ-FONT-001 REQ-FONT-002 */
  async getTextSize(owner: Principal): Promise<TextSizePreference> {
    const result = await this.pool.query<TextSizePreference>(
      'SELECT size FROM user_text_preferences WHERE tenant_id=$1 AND object_id=$2',
      [owner.tenantId, owner.objectId],
    );
    return result.rows[0] ? textSizeSchema.parse(result.rows[0]) : { ...defaultTextSize };
  }

  async patchTextSize(owner: Principal, changes: TextSizePreference): Promise<TextSizePreference> {
    const result = await this.pool.query<TextSizePreference>(
      `INSERT INTO user_text_preferences(tenant_id,object_id,size) VALUES($1,$2,$3)
       ON CONFLICT(tenant_id,object_id) DO UPDATE SET size=EXCLUDED.size RETURNING size`,
      [owner.tenantId, owner.objectId, changes.size],
    );
    return textSizeSchema.parse(result.rows[0]);
  }
}

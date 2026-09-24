// What the signed-in user may do and see (mirrors server/domain/roles.ts; the server enforces it).
import type { Block, Cap, OrgKind, Role } from '../../server/domain/roles';

export interface Me {
  id: string;
  login: string;
  role: Role;
  role_label: string;
  label: string | null;
  org_id: string;
  org_kind: OrgKind;
  org_name: string;
  share_location_up: boolean;
  tz: string;
  is_demo: boolean;
  protected: boolean;
  caps: Cap[];
  blocks: Block[];
  machine_ids: string[] | null;
  owner_admin: boolean;
}

export const can = (me: Me, cap: Cap) => me.caps.includes(cap);
export const sees = (me: Me, block: Block) => me.blocks.includes(block);
